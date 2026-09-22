import {
  RepositoryProfile,
  PlanRevision,
  PlanRevisionType,
  PlannerProvenance,
  PlannerSource,
} from '@taskforge/shared';
import { Goal, Task, TaskGraph, Planner } from '@taskforge/core';
import { HeuristicPlanner, isPureExplanationGoal } from './planner.js';
import { TaskGraphValidator, RawPlanOutput } from './task-graph-validator.js';

export type { PlanRevision, PlanRevisionType, PlannerProvenance, PlannerSource };


export interface SemanticPlanOptions {
  previousGraph?: TaskGraph;
  planFeedback?: string | PlanRevision;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export const SEMANTIC_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          type: {
            type: 'string',
            enum: [
              'implementation',
              'investigation',
              'review',
              'testing',
              'refactoring',
              'architecture',
            ],
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
          },
          objective: { type: 'string' },
          allowedScope: {
            type: 'array',
            items: { type: 'string' },
          },
          forbiddenChanges: {
            type: 'array',
            items: { type: 'string' },
          },
          acceptanceCriteria: {
            type: 'array',
            items: { type: 'string' },
          },
          completionMode: {
            type: 'string',
            enum: ['mutation', 'report', 'verification', 'review'],
          },
          verification: {
            type: ['object', 'null'],
            properties: {
              commands: {
                type: 'array',
                items: { type: 'string' },
              },
              expectation: {
                type: 'string',
                enum: ['observe', 'pass'],
              },
            },
            required: ['commands', 'expectation'],
            additionalProperties: false,
          },
        },
        required: [
          'taskId',
          'title',
          'description',
          'type',
          'dependencies',
          'objective',
          'allowedScope',
          'forbiddenChanges',
          'acceptanceCriteria',
          'completionMode',
          'verification',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'tasks'],
  additionalProperties: false,
};

export type ModelCaller = (
  messages: Array<{ role: string; content: string }>,
  schema: Record<string, unknown>,
) => Promise<RawPlanOutput>;

function isTerminalProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const statusMatch = error.message.match(/HTTP\s+(\d{3})/i);
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);

  // Retrying these immediately only adds latency: auth/configuration errors
  // and quota limits will not heal within the same planning loop.
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 429;
}

export class SemanticPlanner implements Planner {
  private apiKey?: string;
  private model: string;
  private timeoutMs: number;
  public readonly promptVersion = 'v1.0';
  public readonly schemaVersion = 'v1.0';
  private fallbackPlanner: HeuristicPlanner;
  private customCaller?: ModelCaller;
  private maxRetries = 2;

  constructor(options: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    fallbackPlanner?: HeuristicPlanner;
    customCaller?: ModelCaller;
  } = {}) {
    this.apiKey =
      'apiKey' in options
        ? options.apiKey
        : process.env.TASKFORGE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    this.model = options.model ?? 'gpt-5.6-luna';
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fallbackPlanner = options.fallbackPlanner ?? new HeuristicPlanner();
    this.customCaller = options.customCaller;
  }

  public setModelCaller(caller?: ModelCaller): void {
    this.customCaller = caller;
  }

  public classifyGoal(goal: Goal): { isComplex: boolean; minTasks: number } {
    const text = goal.description;

    const rawLines = text
      .split('\n')
      .map((l) => l.replace(/^[-*•>\d.]+\s*/, '').trim())
      .filter((l) => l.length > 0);

    const clauses: string[] = [];
    if (rawLines.length > 2) {
      clauses.push(...rawLines);
    } else {
      const parts = text
        .split(/;|\band\b|\bwith\b/i)
        .map((p) => p.trim())
        .filter((p) => p.length > 10);
      if (parts.length >= 3) {
        clauses.push(...parts);
      }
    }

    const lower = text.toLowerCase();
    const hasComplexKeywords =
      lower.includes('complex') ||
      lower.includes('cross-cutting') ||
      lower.includes('end-to-end') ||
      lower.includes('self-hosting') ||
      lower.includes('pipeline') ||
      lower.includes('subsystems') ||
      lower.includes('architecture') ||
      lower.includes('dogfood');

    const isComplex = clauses.length >= 3 || (hasComplexKeywords && (clauses.length >= 2 || text.length > 60));
    const minTasks = isComplex ? Math.max(3, Math.min(clauses.length || 3, 6)) : 1;

    return { isComplex, minTasks };
  }

  async plan(
    goal: Goal,
    profile?: RepositoryProfile,
    options: SemanticPlanOptions = {},
  ): Promise<TaskGraph> {
    const apiKey = 'apiKey' in options ? options.apiKey : this.apiKey;
    const model = options.model ?? this.model;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const { minTasks } = this.classifyGoal(goal);

    // Simple repository summaries/explanations do not benefit from semantic
    // decomposition. Bypass the model entirely so they stay one read-only task
    // with low latency and predictable agent usage.
    if (isPureExplanationGoal(goal.description)) {
      const graph = await this.fallbackPlanner.plan(goal, profile);
      const plannerProvenance: PlannerProvenance = {
        source: 'deterministic_decomposition',
        fallbackReason: 'lightweight_read_only_fast_path',
        promptVersion: this.promptVersion,
        schemaVersion: this.schemaVersion,
      };
      graph.metadata = {
        ...(graph.metadata ?? {}),
        planner: plannerProvenance,
        source: 'deterministic_decomposition',
        fallbackReason: 'lightweight_read_only_fast_path',
        promptVersion: this.promptVersion,
        schemaVersion: this.schemaVersion,
      };
      return graph;
    }

    // 1. Try semantic planning with model caller if configured
    if (this.customCaller || apiKey) {
      let lastErrors: string[] = [];

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const messages = this.buildPromptMessages(goal, profile, options, lastErrors);
          let rawOutput: RawPlanOutput;

          if (this.customCaller) {
            rawOutput = await this.customCaller(messages, SEMANTIC_PLAN_JSON_SCHEMA);
          } else {
            rawOutput = await this.callOpenAI(messages, apiKey!, model, timeoutMs);
          }

          const validation = TaskGraphValidator.validate(rawOutput, goal.id, { minTasks });
          if (validation.valid && validation.graph) {
            const plannerProvenance: PlannerProvenance = {
              source: 'semantic_model',
              provider: this.customCaller ? 'custom' : 'openai',
              model,
              promptVersion: this.promptVersion,
              schemaVersion: this.schemaVersion,
            };
            validation.graph.metadata = {
              ...(validation.graph.metadata ?? {}),
              planner: plannerProvenance,
              source: 'semantic',
              model,
              promptVersion: this.promptVersion,
              schemaVersion: this.schemaVersion,
            };
            return validation.graph;
          }

          lastErrors = validation.errors;
        } catch (err) {
          lastErrors = [(err as Error).message];
          if (isTerminalProviderError(err)) {
            break;
          }
        }
      }
    }

    // 2. Complex Goal Semantic Decomposition (Fallback engine for complex multi-clause objectives)
    const decomposed = this.tryDecomposeComplexGoal(goal, profile);
    if (decomposed) {
      const validation = TaskGraphValidator.validate(decomposed, goal.id, {
        minTasks: Math.min(minTasks, decomposed.tasks.length),
      });
      if (validation.valid && validation.graph) {
        const fallbackReason = apiKey || this.customCaller ? 'model_unresponsive_or_invalid' : undefined;
        const plannerProvenance: PlannerProvenance = {
          source: 'deterministic_decomposition',
          fallbackReason,
          promptVersion: this.promptVersion,
          schemaVersion: this.schemaVersion,
        };
        validation.graph.metadata = {
          ...(validation.graph.metadata ?? {}),
          planner: plannerProvenance,
          source: 'deterministic_decomposition',
          fallbackReason,
          promptVersion: this.promptVersion,
          schemaVersion: this.schemaVersion,
        };
        return validation.graph;
      }
    }

    // 3. Fallback to heuristic planner
    const fallbackGraph = await this.fallbackPlanner.plan(goal, profile);
    const fallbackReason = apiKey || this.customCaller ? 'model_unresponsive_or_invalid' : 'no_model_configured';
    const plannerProvenance: PlannerProvenance = {
      source: 'heuristic_fallback',
      fallbackReason,
      model: this.model,
      promptVersion: this.promptVersion,
      schemaVersion: this.schemaVersion,
    };
    fallbackGraph.metadata = {
      ...(fallbackGraph.metadata ?? {}),
      planner: plannerProvenance,
      source: apiKey || this.customCaller ? 'fallback' : 'heuristic',
      model: this.model,
      fallbackReason,
      promptVersion: this.promptVersion,
      schemaVersion: this.schemaVersion,
    };
    return fallbackGraph;
  }

  async revise(
    currentGraph: TaskGraph,
    goal: Goal,
    revision: PlanRevision,
    _profile?: RepositoryProfile,
  ): Promise<TaskGraph> {
    const existingTasks = currentGraph.getAllTasks();
    const revType: PlanRevisionType = revision.revisionType ?? revision.type ?? 'general_feedback';
    const feedbackText =
      revision.feedback ||
      (typeof revision.details === 'string' ? revision.details : '') ||
      '';

    const buildValidatedGraph = (tasks: Task[], type: PlanRevisionType): TaskGraph => {
      const rawPlan: RawPlanOutput = {
        summary: `Revised plan (${type})`,
        tasks: tasks.map((t) => ({
          taskId: t.id,
          title: t.title,
          description: t.description,
          type: t.type,
          dependencies: t.dependencies,
          objective: t.contract.objective,
          allowedScope: t.contract.allowedScope,
          forbiddenChanges: t.contract.forbiddenChanges,
          acceptanceCriteria: t.contract.acceptanceCriteria,
          completionMode: t.contract.completionMode,
          verification: t.contract.verification ?? null,
        })),
      };

      const val = TaskGraphValidator.validate(rawPlan, goal.id);
      if (!val.valid || !val.graph) {
        throw new Error(`Revised task graph failed validation: ${val.errors.join(', ')}`);
      }

      val.graph.metadata = {
        ...(currentGraph.metadata ?? {}),
        planner: currentGraph.metadata?.planner,
        source: currentGraph.metadata?.source ?? 'semantic',
        revised: true,
        revisionType: type,
        feedback: feedbackText,
      };
      return val.graph;
    };

    // 1. add_constraint
    if (revType === 'add_constraint') {
      const forbidden =
        (typeof revision.details === 'object' && revision.details !== null
          ? (revision.details as any).forbiddenScope
          : undefined) ??
        (feedbackText.match(/(?:don't|do not|must not|constraint)\s+(?:modify|touch|change)?\s*(?:the\s+)?(.+)/i)?.[1] ||
          feedbackText);

      const updatedTasks = existingTasks.map((t) => {
        const forbiddenChanges = [...t.contract.forbiddenChanges];
        if (forbidden && !forbiddenChanges.includes(forbidden.trim())) {
          forbiddenChanges.push(forbidden.trim());
        }
        return {
          ...t,
          contract: {
            ...t.contract,
            forbiddenChanges,
          },
          updatedAt: new Date(),
        };
      });

      return buildValidatedGraph(updatedTasks, 'add_constraint');
    }

    // 2. modify_dependency
    if (revType === 'modify_dependency') {
      let targetTaskId =
        revision.taskId ??
        (typeof revision.details === 'object' && revision.details !== null
          ? (revision.details as any).task
          : undefined);
      let dependsOnId =
        typeof revision.details === 'object' && revision.details !== null
          ? (revision.details as any).dependsOn
          : undefined;

      if (!targetTaskId || !dependsOnId) {
        const match = feedbackText.match(
          /task\s*(\d+|[A-Z0-9_-]+)\s*should\s+depend\s+on\s+task\s*(\d+|[A-Z0-9_-]+)/i,
        );
        if (match) {
          const numA = match[1];
          const numB = match[2];
          targetTaskId = numA.startsWith('TASK-') ? numA.toUpperCase() : `TASK-${numA.padStart(2, '0')}`;
          dependsOnId = numB.startsWith('TASK-') ? numB.toUpperCase() : `TASK-${numB.padStart(2, '0')}`;
        }
      }

      if (targetTaskId && dependsOnId) {
        const target = existingTasks.find(
          (t) => t.id.toUpperCase() === targetTaskId.toUpperCase(),
        );
        const dep = existingTasks.find(
          (t) => t.id.toUpperCase() === dependsOnId.toUpperCase(),
        );

        if (target && dep) {
          const updatedTasks = existingTasks.map((t) => {
            if (t.id === target.id && !t.dependencies.includes(dep.id)) {
              const newDeps = [...t.dependencies, dep.id];
              return {
                ...t,
                dependencies: newDeps,
                contract: { ...t.contract, dependencies: newDeps },
                updatedAt: new Date(),
              };
            }
            return t;
          });

          return buildValidatedGraph(updatedTasks, 'modify_dependency');
        }
      }
    }

    // 3. add_task
    if (revType === 'add_task') {
      const isVerification =
        feedbackText.toLowerCase().includes('verification') ||
        feedbackText.toLowerCase().includes('verify') ||
        feedbackText.toLowerCase().includes('test');

      const nextNum = existingTasks.length + 1;
      const newTaskId = `TASK-${String(nextNum).padStart(2, '0')}`;
      const previousIds = existingTasks.filter((t) => t.type === 'implementation').map((t) => t.id);

      const newTask: Task = {
        id: newTaskId,
        goalId: goal.id,
        title: isVerification
          ? 'Comprehensive Verification and Quality Review'
          : `Additional Task: ${feedbackText}`,
        description: isVerification
          ? 'Execute full automated verification, regression tests, and acceptance validation'
          : feedbackText,
        type: isVerification ? 'testing' : 'implementation',
        status: 'proposed',
        dependencies: previousIds.length > 0 ? [previousIds[previousIds.length - 1]] : [],
        contract: {
          objective: isVerification ? 'Verify all acceptance criteria pass' : feedbackText,
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: ['All tests and quality checks pass'],
          dependencies: previousIds.length > 0 ? [previousIds[previousIds.length - 1]] : [],
        },
        acceptanceCriteria: ['All tests and quality checks pass'],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return buildValidatedGraph([...existingTasks, newTask], 'add_task');
    }

    // 4. split_task
    if (revType === 'split_task') {
      const targetId = revision.taskId;
      const broadTask =
        (targetId ? existingTasks.find((t) => t.id.toUpperCase() === targetId.toUpperCase()) : undefined) ??
        existingTasks.find((t) => t.type === 'implementation' || t.dependencies.length === 0) ??
        existingTasks[0];

      if (broadTask) {
        const splitMatch = feedbackText.match(/split\s+(.+)\s+from\s+(.+)/i);
        const partA = splitMatch ? splitMatch[1].trim() : 'Part A';
        const partB = splitMatch ? splitMatch[2].trim() : 'Part B';

        const idA = broadTask.id;
        const idB = `TASK-${String(existingTasks.length + 1).padStart(2, '0')}`;

        const taskA: Task = {
          ...broadTask,
          title: `Implement ${partA}`,
          description: `Focused implementation for: ${partA}`,
          contract: {
            ...broadTask.contract,
            objective: `Implement ${partA}`,
          },
          updatedAt: new Date(),
        };

        const taskB: Task = {
          id: idB,
          goalId: goal.id,
          title: `Implement ${partB}`,
          description: `Focused implementation for: ${partB}`,
          type: 'implementation',
          status: 'proposed',
          dependencies: [idA],
          contract: {
            objective: `Implement ${partB}`,
            allowedScope: broadTask.contract.allowedScope,
            forbiddenChanges: broadTask.contract.forbiddenChanges,
            acceptanceCriteria: [`${partB} implemented and verified`],
            dependencies: [idA],
          },
          acceptanceCriteria: [`${partB} implemented and verified`],
          reworkCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const remainingTasks = existingTasks
          .filter((t) => t.id !== broadTask.id)
          .map((t) => {
            if (t.dependencies.includes(broadTask.id)) {
              return {
                ...t,
                dependencies: [...t.dependencies.filter((d) => d !== broadTask.id), idB],
                contract: {
                  ...t.contract,
                  dependencies: [...t.contract.dependencies.filter((d) => d !== broadTask.id), idB],
                },
              };
            }
            return t;
          });

        return buildValidatedGraph([taskA, taskB, ...remainingTasks], 'split_task');
      }
    }

    // 5. general_feedback / assign_agent
    const updatedTasks = existingTasks.map((t) => ({
      ...t,
      contract: {
        ...t.contract,
        objective: `${t.contract.objective} (Requirement: ${feedbackText})`,
        acceptanceCriteria: [...t.contract.acceptanceCriteria, `Satisfies constraint: ${feedbackText}`],
      },
      updatedAt: new Date(),
    }));

    return buildValidatedGraph(updatedTasks, revType);
  }

  private buildPromptMessages(
    goal: Goal,
    profile?: RepositoryProfile,
    options: SemanticPlanOptions = {},
    lastErrors: string[] = [],
  ): Array<{ role: string; content: string }> {
    const errorBlock =
      lastErrors.length > 0
        ? `\n\nPrevious attempt failed validation with errors:\n${lastErrors.map((e) => `- ${e}`).join('\n')}\nPlease fix all issues in the output structure.`
        : '';

    const feedbackBlock = options.planFeedback
      ? `\n\nUser revision/feedback on prior plan:\n${
          typeof options.planFeedback === 'string'
            ? options.planFeedback
            : `${options.planFeedback.revisionType}: ${options.planFeedback.feedback}`
        }`
      : '';

    const constraintsBlock =
      goal.constraints && goal.constraints.length > 0
        ? `\nExplicit constraints:\n${goal.constraints.map((c) => `- ${c.value || c.type}`).join('\n')}`
        : '';

    return [
      {
        role: 'system',
        content: `You are the TaskForge Semantic Planner.
Decompose the engineering objective into an optimal, typed DAG of tasks.
Never collapse complex engineering requirements into generic 2-task plans.

Every task must declare explicit completion semantics:
- mutation: repository changes are the completion evidence.
- report: read-only analysis/report; allowedScope must be [] and forbiddenChanges must be ["*"].
- verification: read-only command execution; allowedScope must be [] and forbiddenChanges must be ["*"]. Set verification.commands to the exact commands and verification.expectation to "observe" when establishing/capturing a baseline, otherwise "pass".
- review: read-only review findings; allowedScope must be [] and forbiddenChanges must be ["*"].
Never invent writable paths for report/review/verification tasks.

Output strictly according to the json_schema.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          goal: goal.description,
          constraints: constraintsBlock,
          feedback: feedbackBlock,
          errorFeedback: errorBlock,
          repository: profile
            ? {
                summary: profile.summary,
                languages: profile.languages,
                frameworks: profile.frameworks,
                testCommands: profile.testCommands,
                hasECC: profile.hasECC,
              }
            : undefined,
        }),
      },
    ];
  }

  private async callOpenAI(
    messages: Array<{ role: string; content: string }>,
    apiKey: string,
    model: string,
    timeoutMs: number,
  ): Promise<RawPlanOutput> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'task_graph',
              strict: true,
              schema: SEMANTIC_PLAN_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI planner API failed: HTTP ${response.status}`);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from model planner');
      }

      return JSON.parse(content) as RawPlanOutput;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Deterministic semantic decomposition for complex multi-clause engineering goals.
   * Breaks down complex goals containing multiple concrete architectural requirements
   * into an acyclic task graph rather than a generic 2-task plan.
   */
  public tryDecomposeComplexGoal(
    goal: Goal,
    _profile?: RepositoryProfile,
  ): RawPlanOutput | null {
    const text = goal.description;

    // Detect if this is a complex multi-clause engineering prompt
    const clauses: string[] = [];

    // Split on bullet points or comma/and patterns
    const rawLines = text
      .split('\n')
      .map((l) => l.replace(/^[-*•>]\s*/, '').trim())
      .filter((l) => l.length > 0);

    if (rawLines.length > 2) {
      clauses.push(...rawLines);
    } else {
      // Split on comma or "and" if long sentence with multiple keywords
      const parts = text.split(/,|;\s*|\band\b/i).map((p) => p.trim()).filter((p) => p.length > 8);
      if (parts.length >= 3) {
        clauses.push(...parts);
      }
    }

    if (clauses.length < 3) {
      return null;
    }

    // Map clauses to typed tasks
    const tasks: RawPlanOutput['tasks'] = [];
    const createdIds: string[] = [];

    clauses.forEach((clause, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      const taskId = `TASK-${num}`;
      const lower = clause.toLowerCase();

      let taskType: RawPlanOutput['tasks'][0]['type'] = 'implementation';
      if (lower.includes('investigate') || lower.includes('analyze') || lower.includes('audit')) {
        taskType = 'investigation';
      } else if (lower.includes('review') || lower.includes('critique')) {
        taskType = 'review';
      } else if (lower.includes('test') || lower.includes('verify') || lower.includes('regression')) {
        taskType = 'testing';
      } else if (lower.includes('refactor') || lower.includes('clean') || lower.includes('structure')) {
        taskType = 'refactoring';
      }

      // Dependencies:
      // Later tasks depend on earlier tasks in sensible topological pipeline
      const dependencies: string[] = [];
      if (idx > 0) {
        // Find previous implementation or investigation
        const prevId = createdIds[idx - 1];
        if (prevId) {
          dependencies.push(prevId);
        }
      }

      const testingAuthorsCode =
        taskType === 'testing' &&
        /\b(write|add|create|implement|author|introduce|generate|update|modify)\b.*\b(tests?|specs?|fixtures?|suites?)\b/i.test(clause);
      const isVerification =
        taskType === 'testing' &&
        !testingAuthorsCode &&
        /\b(run|execute|verify|validate|check|typecheck|lint|build|compile|baseline)\b/i.test(clause);
      const completionMode =
        taskType === 'investigation'
          ? 'report'
          : taskType === 'review'
            ? 'review'
            : isVerification
              ? 'verification'
              : 'mutation';
      const commandMatches =
        isVerification
          ? clause.match(/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|lint|build|test)\b/gi) ?? []
          : [];

      tasks.push({
        taskId,
        title: clause.length > 60 ? `${clause.slice(0, 57)}...` : clause,
        description: `Execute engineering requirement: ${clause}`,
        type: taskType,
        dependencies,
        objective: clause,
        allowedScope: completionMode === 'mutation' ? ['*'] : [],
        forbiddenChanges: completionMode === 'mutation' ? [] : ['*'],
        acceptanceCriteria: [`Requirement "${clause}" is implemented and verified`],
        completionMode,
        verification:
          completionMode === 'verification'
            ? {
                commands: commandMatches.map((command) => command.trim()),
                expectation: /\bbaseline\b/i.test(clause) ? 'observe' : 'pass',
              }
            : null,
      });

      createdIds.push(taskId);
    });

    return {
      summary: `Decomposed into ${tasks.length} structured engineering tasks`,
      tasks,
    };
  }
}
