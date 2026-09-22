import { Task, TaskGraph } from '@taskforge/core';
import {
  TaskType,
  TaskContract,
  CompletionMode,
  VerificationExpectation,
} from '@taskforge/shared';

export interface ValidationIssue {
  field: string;
  message: string;
  taskId?: string;
}

export interface TaskGraphValidationResult {
  valid: boolean;
  errors: string[];
  issues: ValidationIssue[];
  graph?: TaskGraph;
}

export interface RawPlanTask {
  taskId: string;
  title: string;
  description: string;
  type: string;
  dependencies: string[];
  objective: string;
  allowedScope?: string[];
  forbiddenChanges?: string[];
  acceptanceCriteria: string[];
  completionMode?: string;
  verification?: {
    commands: string[];
    expectation: string;
  } | null;
}

export interface RawPlanOutput {
  summary?: string;
  tasks: RawPlanTask[];
}

const VALID_TASK_TYPES = new Set<TaskType>([
  'implementation',
  'investigation',
  'review',
  'testing',
  'refactoring',
  'architecture',
]);

const VALID_COMPLETION_MODES = new Set<CompletionMode>([
  'mutation',
  'report',
  'verification',
  'review',
]);

const VALID_VERIFICATION_EXPECTATIONS = new Set<VerificationExpectation>(['observe', 'pass']);

function taskText(task: RawPlanTask): string {
  return `${task.title ?? ''} ${task.description ?? ''} ${task.objective ?? ''}`.toLowerCase();
}

function inferCompletionMode(task: RawPlanTask, taskType: TaskType): CompletionMode {
  if (taskType === 'implementation' || taskType === 'refactoring') return 'mutation';
  if (taskType === 'investigation') return 'report';
  if (taskType === 'review') return 'review';

  const text = taskText(task);
  if (taskType === 'architecture') {
    return /\b(scaffold|bootstrap|create files?|initialize|skeleton|workspace|directory structure)\b/i.test(text)
      ? 'mutation'
      : 'report';
  }

  const authorsTests =
    /\b(write|add|create|implement|author|introduce|scaffold|generate|update|modify|refactor)\b.*\b(tests?|specs?|fixtures?|suites?)\b/i.test(text) ||
    /\b(new tests?|unit tests?|integration tests?|regression tests?|e2e tests?|acceptance tests?|test coverage)\b/i.test(text);

  if (authorsTests) return 'mutation';

  if (
    /\b(run|execute|verify|validate|check|assert|inspect|establish)\b.*\b(tests?|suite|typecheck|lint|build|compile|compilation|baseline|verification|checks?)\b/i.test(text) ||
    /\b(typecheck|lint|build|compile|compilation)\b/i.test(text)
  ) {
    return 'verification';
  }

  // Legacy TESTING tasks were ambiguous. Preserve the old mutation default only
  // at the planning boundary; the CompletionGate itself no longer guesses.
  return 'mutation';
}

function inferVerificationCommands(task: RawPlanTask): string[] {
  const text = `${task.title ?? ''}\n${task.description ?? ''}\n${task.objective ?? ''}`;
  const commands = new Set<string>();
  const packageCommands = text.match(/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|lint|build|test)(?:\s+[^\n,;]*)?/gi) ?? [];
  for (const command of packageCommands) {
    commands.add(command.trim().replace(/[.]+$/, ''));
  }
  return [...commands];
}

function scopesOverlap(allowed: string, forbidden: string): boolean {
  const a = allowed.trim();
  const f = forbidden.trim();
  if (!a || !f) return false;
  if (a === '*' || f === '*') return true;
  return a === f;
}

export class TaskGraphValidator {
  public static readonly MIN_TASKS = 1;
  public static readonly MAX_TASKS = 20;

  public static validate(
    raw: unknown,
    goalId: string = 'default-goal',
    options?: { minTasks?: number; maxTasks?: number },
  ): TaskGraphValidationResult {
    const errors: string[] = [];
    const issues: ValidationIssue[] = [];

    if (!raw || typeof raw !== 'object') {
      return {
        valid: false,
        errors: ['Plan output must be a non-null object'],
        issues: [{ field: 'root', message: 'Plan output must be a non-null object' }],
      };
    }

    const plan = raw as RawPlanOutput;
    if (!Array.isArray(plan.tasks)) {
      return {
        valid: false,
        errors: ['Plan must contain a "tasks" array'],
        issues: [{ field: 'tasks', message: 'Plan must contain a "tasks" array' }],
      };
    }

    const minTasks = options?.minTasks ?? this.MIN_TASKS;
    const maxTasks = options?.maxTasks ?? this.MAX_TASKS;

    // 1. Bounded number of tasks
    if (plan.tasks.length < minTasks) {
      const msg = `Plan contains only ${plan.tasks.length} tasks, which is fewer than required minimum (${minTasks})`;
      errors.push(msg);
      issues.push({ field: 'tasks', message: msg });
    }
    if (plan.tasks.length > maxTasks) {
      const msg = `Plan task count (${plan.tasks.length}) exceeds maximum limit (${maxTasks})`;
      errors.push(msg);
      issues.push({ field: 'tasks', message: msg });
    }

    const taskIds = new Set<string>();
    const seenNormalizedTitles = new Map<string, string>();
    const seenNormalizedObjectives = new Map<string, string>();

    // 2. Validate individual tasks
    for (let i = 0; i < plan.tasks.length; i++) {
      const rawTask = plan.tasks[i];
      const indexField = `tasks[${i}]`;

      if (!rawTask || typeof rawTask !== 'object') {
        const msg = `Task at index ${i} is not a valid object`;
        errors.push(msg);
        issues.push({ field: indexField, message: msg });
        continue;
      }

      // Task ID
      if (!rawTask.taskId || typeof rawTask.taskId !== 'string' || !rawTask.taskId.trim()) {
        const msg = `Task at index ${i} has invalid or missing taskId`;
        errors.push(msg);
        issues.push({ field: `${indexField}.taskId`, message: msg });
      } else {
        const normalizedId = rawTask.taskId.trim().toUpperCase();
        if (taskIds.has(normalizedId)) {
          const msg = `Duplicate task ID detected: ${rawTask.taskId}`;
          errors.push(msg);
          issues.push({ field: `${indexField}.taskId`, message: msg, taskId: rawTask.taskId });
        }
        taskIds.add(normalizedId);
      }

      // Title & Description
      if (!rawTask.title || typeof rawTask.title !== 'string' || rawTask.title.trim().length < 3) {
        const msg = `Task ${rawTask.taskId ?? i} has missing or too short title`;
        errors.push(msg);
        issues.push({ field: `${indexField}.title`, message: msg, taskId: rawTask.taskId });
      }
      if (!rawTask.description || typeof rawTask.description !== 'string') {
        const msg = `Task ${rawTask.taskId ?? i} is missing a description`;
        errors.push(msg);
        issues.push({ field: `${indexField}.description`, message: msg, taskId: rawTask.taskId });
      }

      // Task Type
      const taskType = (rawTask.type || '').toLowerCase() as TaskType;
      if (!VALID_TASK_TYPES.has(taskType)) {
        const msg = `Task ${rawTask.taskId ?? i} has invalid type: "${rawTask.type}". Must be one of: ${Array.from(VALID_TASK_TYPES).join(', ')}`;
        errors.push(msg);
        issues.push({ field: `${indexField}.type`, message: msg, taskId: rawTask.taskId });
      }

      // Contract
      if (!rawTask.objective || typeof rawTask.objective !== 'string' || !rawTask.objective.trim()) {
        const msg = `Task ${rawTask.taskId ?? i} contract missing objective`;
        errors.push(msg);
        issues.push({ field: `${indexField}.objective`, message: msg, taskId: rawTask.taskId });
      }

      // Allowed / Forbidden Scope
      if (rawTask.allowedScope !== undefined) {
        if (!Array.isArray(rawTask.allowedScope) || rawTask.allowedScope.some((s) => typeof s !== 'string' || s.trim() === '')) {
          const msg = `Task ${rawTask.taskId ?? i} has invalid allowedScope structure`;
          errors.push(msg);
          issues.push({ field: `${indexField}.allowedScope`, message: msg, taskId: rawTask.taskId });
        }
      }

      if (rawTask.forbiddenChanges !== undefined) {
        if (!Array.isArray(rawTask.forbiddenChanges) || rawTask.forbiddenChanges.some((s) => typeof s !== 'string')) {
          const msg = `Task ${rawTask.taskId ?? i} has invalid forbiddenChanges structure`;
          errors.push(msg);
          issues.push({ field: `${indexField}.forbiddenChanges`, message: msg, taskId: rawTask.taskId });
        }
      }

      const explicitCompletionMode =
        typeof rawTask.completionMode === 'string' && rawTask.completionMode.trim().length > 0;
      const completionMode = explicitCompletionMode
        ? (rawTask.completionMode!.toLowerCase() as CompletionMode)
        : inferCompletionMode(rawTask, taskType);

      if (!VALID_COMPLETION_MODES.has(completionMode)) {
        const msg = `Task ${rawTask.taskId ?? i} has invalid completionMode: "${rawTask.completionMode}"`;
        errors.push(msg);
        issues.push({ field: `${indexField}.completionMode`, message: msg, taskId: rawTask.taskId });
      } else {
        const allowed = Array.isArray(rawTask.allowedScope) ? rawTask.allowedScope : [];
        const forbidden = Array.isArray(rawTask.forbiddenChanges) ? rawTask.forbiddenChanges : [];

        for (const allowedEntry of allowed) {
          for (const forbiddenEntry of forbidden) {
            if (scopesOverlap(allowedEntry, forbiddenEntry)) {
              const msg = `Task ${rawTask.taskId ?? i} has contradictory scope: "${allowedEntry}" is both allowed and forbidden`;
              errors.push(msg);
              issues.push({ field: `${indexField}.allowedScope`, message: msg, taskId: rawTask.taskId });
            }
          }
        }

        if (
          explicitCompletionMode &&
          completionMode !== 'mutation' &&
          allowed.length > 0
        ) {
          const msg = `Task ${rawTask.taskId ?? i} is ${completionMode} but declares writable allowedScope; non-mutation tasks must be read-only`;
          errors.push(msg);
          issues.push({ field: `${indexField}.allowedScope`, message: msg, taskId: rawTask.taskId });
        }

        if (completionMode === 'mutation' && forbidden.includes('*')) {
          const msg = `Task ${rawTask.taskId ?? i} requires mutation but forbids all repository changes`;
          errors.push(msg);
          issues.push({ field: `${indexField}.forbiddenChanges`, message: msg, taskId: rawTask.taskId });
        }

        if (completionMode === 'verification') {
          const commands =
            rawTask.verification?.commands?.filter((command) => typeof command === 'string' && command.trim()) ??
            inferVerificationCommands(rawTask);
          const expectation =
            (rawTask.verification?.expectation?.toLowerCase() as VerificationExpectation | undefined) ??
            (/\b(baseline|establish baseline|current state|capture current)\b/i.test(taskText(rawTask))
              ? 'observe'
              : 'pass');

          if (commands.length === 0) {
            const msg = `Task ${rawTask.taskId ?? i} is verification-only but declares no executable verification command`;
            errors.push(msg);
            issues.push({ field: `${indexField}.verification.commands`, message: msg, taskId: rawTask.taskId });
          }
          if (!VALID_VERIFICATION_EXPECTATIONS.has(expectation)) {
            const msg = `Task ${rawTask.taskId ?? i} has invalid verification expectation: "${rawTask.verification?.expectation}"`;
            errors.push(msg);
            issues.push({ field: `${indexField}.verification.expectation`, message: msg, taskId: rawTask.taskId });
          }
        }
      }

      // Acceptance criteria
      if (
        !Array.isArray(rawTask.acceptanceCriteria) ||
        rawTask.acceptanceCriteria.length === 0 ||
        rawTask.acceptanceCriteria.some((c) => typeof c !== 'string' || !c.trim())
      ) {
        const msg = `Task ${rawTask.taskId ?? i} must have at least one valid acceptance criterion`;
        errors.push(msg);
        issues.push({ field: `${indexField}.acceptanceCriteria`, message: msg, taskId: rawTask.taskId });
      }

      // Duplicate task detection (identical title or identical objective)
      if (rawTask.title && typeof rawTask.title === 'string') {
        const normTitle = rawTask.title.trim().toLowerCase();
        if (seenNormalizedTitles.has(normTitle)) {
          const firstId = seenNormalizedTitles.get(normTitle)!;
          const msg = `Duplicate task detected: "${rawTask.title}" in ${rawTask.taskId} is identical to ${firstId}`;
          errors.push(msg);
          issues.push({ field: `${indexField}.title`, message: msg, taskId: rawTask.taskId });
        } else {
          seenNormalizedTitles.set(normTitle, rawTask.taskId);
        }
      }

      if (rawTask.objective && typeof rawTask.objective === 'string') {
        const normObj = rawTask.objective.trim().toLowerCase();
        if (seenNormalizedObjectives.has(normObj)) {
          const firstId = seenNormalizedObjectives.get(normObj)!;
          const msg = `Duplicate objective detected in ${rawTask.taskId} identical to ${firstId}`;
          errors.push(msg);
          issues.push({ field: `${indexField}.objective`, message: msg, taskId: rawTask.taskId });
        } else {
          seenNormalizedObjectives.set(normObj, rawTask.taskId);
        }
      }
    }

    // 3. Dependencies validation & cycle detection
    const adjacency = new Map<string, string[]>();
    for (const rawTask of plan.tasks) {
      if (!rawTask.taskId) continue;
      const id = rawTask.taskId.trim().toUpperCase();
      const deps = Array.isArray(rawTask.dependencies)
        ? rawTask.dependencies.map((d) => d.trim().toUpperCase())
        : [];
      adjacency.set(id, deps);

      for (const dep of deps) {
        // Self-dependency
        if (dep === id) {
          const msg = `Task ${rawTask.taskId} has self-dependency on ${dep}`;
          errors.push(msg);
          issues.push({ field: `tasks.${rawTask.taskId}.dependencies`, message: msg, taskId: rawTask.taskId });
        }
        // Non-existent dependency
        else if (!taskIds.has(dep)) {
          const msg = `Task ${rawTask.taskId} references non-existent dependency: "${dep}"`;
          errors.push(msg);
          issues.push({ field: `tasks.${rawTask.taskId}.dependencies`, message: msg, taskId: rawTask.taskId });
        }
      }
    }

    // Cycle detection in DAG using DFS
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const checkCycle = (node: string, path: string[]): boolean => {
      visited.add(node);
      inStack.add(node);

      const neighbors = adjacency.get(node) || [];
      for (const neighbor of neighbors) {
        if (!taskIds.has(neighbor)) continue;
        if (!visited.has(neighbor)) {
          if (checkCycle(neighbor, [...path, neighbor])) return true;
        } else if (inStack.has(neighbor)) {
          const cycleStr = [...path, neighbor].join(' -> ');
          const msg = `Cyclic dependency detected in task graph: ${cycleStr}`;
          errors.push(msg);
          issues.push({ field: 'dependencies', message: msg, taskId: node });
          return true;
        }
      }

      inStack.delete(node);
      return false;
    };

    for (const taskId of taskIds) {
      if (!visited.has(taskId)) {
        checkCycle(taskId, [taskId]);
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        issues,
      };
    }

    // 4. Construct TaskGraph
    const now = new Date();
    const tasks: Task[] = plan.tasks.map((rt) => {
      const id = rt.taskId.trim().toUpperCase();
      const taskType = rt.type.toLowerCase() as TaskType;
      const completionMode =
        rt.completionMode && VALID_COMPLETION_MODES.has(rt.completionMode.toLowerCase() as CompletionMode)
          ? (rt.completionMode.toLowerCase() as CompletionMode)
          : inferCompletionMode(rt, taskType);
      const inferredVerificationCommands =
        completionMode === 'verification' ? inferVerificationCommands(rt) : [];
      const verificationExpectation: VerificationExpectation =
        (rt.verification?.expectation?.toLowerCase() as VerificationExpectation | undefined) ??
        (/\b(baseline|establish baseline|current state|capture current)\b/i.test(taskText(rt))
          ? 'observe'
          : 'pass');

      const contract: TaskContract = {
        objective: rt.objective.trim(),
        allowedScope:
          completionMode === 'mutation'
            ? rt.allowedScope && rt.allowedScope.length > 0
              ? rt.allowedScope
              : ['*']
            : [],
        forbiddenChanges:
          completionMode === 'mutation'
            ? (rt.forbiddenChanges ?? [])
            : ['*'],
        acceptanceCriteria: rt.acceptanceCriteria.map((c) => c.trim()),
        dependencies: (rt.dependencies ?? []).map((d) => d.trim().toUpperCase()),
        completionMode,
        verification:
          completionMode === 'verification'
            ? {
                commands:
                  rt.verification?.commands?.map((command) => command.trim()).filter(Boolean) ??
                  inferredVerificationCommands,
                expectation: verificationExpectation,
              }
            : undefined,
      };

      return {
        id,
        goalId,
        title: rt.title.trim(),
        description: rt.description.trim(),
        type: taskType,
        status: 'proposed',
        dependencies: contract.dependencies,
        contract,
        acceptanceCriteria: contract.acceptanceCriteria,
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    });

    const graph = new TaskGraph(tasks);
    return {
      valid: true,
      errors: [],
      issues: [],
      graph,
    };
  }
}
