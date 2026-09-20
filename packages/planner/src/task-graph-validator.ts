import { Task, TaskGraph } from '@taskforge/core';
import { TaskType, TaskContract } from '@taskforge/shared';

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
      const contract: TaskContract = {
        objective: rt.objective.trim(),
        allowedScope: rt.allowedScope && rt.allowedScope.length > 0 ? rt.allowedScope : ['*'],
        forbiddenChanges: rt.forbiddenChanges ?? [],
        acceptanceCriteria: rt.acceptanceCriteria.map((c) => c.trim()),
        dependencies: (rt.dependencies ?? []).map((d) => d.trim().toUpperCase()),
      };

      return {
        id,
        goalId,
        title: rt.title.trim(),
        description: rt.description.trim(),
        type: rt.type.toLowerCase() as TaskType,
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
