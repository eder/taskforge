import { Goal, Task, TaskGraph } from '@taskforge/core';
import { ExecutionIntentDecision, isLightweightReadOnlyRequest } from '@taskforge/shared';

export interface PlanIntentNormalization {
  taskId: string;
  originalTaskType: string;
  normalizedTaskType: string;
  executionIntent: ExecutionIntentDecision['intent'];
  reason: string;
  originalForbiddenChanges?: string[];
  normalizedForbiddenChanges?: string[];
}

export interface LightweightReadOnlyPlanInvariantResult {
  graph: TaskGraph;
  changed: boolean;
  originalTaskCount: number;
  reason?: string;
}

/**
 * Production safety invariant for cheap repository-overview questions.
 *
 * A lightweight read-only overview must never fan out into multiple tasks,
 * collaboration, review, verification, or mutation merely because a semantic
 * planner over-decomposed it. This is intentionally enforced after planning /
 * negotiation as defense in depth, not just inferred inside one planner.
 */
export function enforceLightweightReadOnlyPlanInvariant(
  graph: TaskGraph,
  goal: Goal,
  intent: ExecutionIntentDecision,
): LightweightReadOnlyPlanInvariantResult {
  const tasks = graph.getAllTasks();
  const lightweight =
    intent.intent === 'READ_ONLY_ANALYSIS' &&
    !intent.mutationAllowed &&
    isLightweightReadOnlyRequest(goal.description);

  if (!lightweight) {
    return { graph, changed: false, originalTaskCount: tasks.length };
  }

  const alreadyCanonical =
    tasks.length === 1 &&
    tasks[0].type === 'investigation' &&
    tasks[0].dependencies.length === 0 &&
    tasks[0].contract.completionMode === 'report' &&
    (tasks[0].contract.allowedScope?.length ?? 0) === 0 &&
    tasks[0].contract.forbiddenChanges?.includes('*') &&
    !tasks[0].contract.metadata?.recommendCollaboration &&
    !tasks[0].contract.metadata?.collaboration;

  if (alreadyCanonical) {
    return { graph, changed: false, originalTaskCount: 1 };
  }

  const now = new Date();
  const firstTask = tasks[0];
  const canonicalTask: Task = {
    id: firstTask?.id ?? 'TASK-01',
    goalId: goal.id,
    title: 'Explain Project and Architecture',
    description: `Read the current repository and answer the user's overview question: ${goal.description}`,
    type: 'investigation',
    status: 'proposed',
    dependencies: [],
    contract: {
      objective: `Explain the current repository using repository evidence only: ${goal.description}`,
      allowedScope: [],
      forbiddenChanges: ['*'],
      acceptanceCriteria: [
        'Answer the user question directly and concisely',
        'Ground factual claims in the current repository contents',
        'Distinguish repository evidence from inference',
        'Make no repository changes',
      ],
      dependencies: [],
      completionMode: 'report',
      metadata: {
        lightweightReadOnlyInvariant: true,
      },
    },
    acceptanceCriteria: [
      'Substantive repository-grounded explanation provided',
      'No repository mutation',
    ],
    reworkCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const canonicalGraph = new TaskGraph([canonicalTask], {
    ...(graph.metadata ?? {}),
    planInvariant: 'lightweight_read_only_single_task',
    originalTaskCount: tasks.length,
  });

  return {
    graph: canonicalGraph,
    changed: true,
    originalTaskCount: tasks.length,
    reason:
      'Lightweight read-only overview invariant collapsed planner output to one repository-grounded report task.',
  };
}

/**
 * Second barrier for execution intent (the first is detectExecutionIntent,
 * applied before planning).
 *
 * READ_ONLY_ANALYSIS is authoritative and closes every task scope.
 *
 * IMPLEMENTATION can still carry run-level scoped restrictions such as
 * "do not modify the Delivery Gate". Those restrictions are merged into each
 * task contract deterministically so a planner cannot accidentally drop them
 * while decomposing the goal.
 */
export function normalizeGraphForExecutionIntent(
  graph: TaskGraph,
  intent: ExecutionIntentDecision,
): PlanIntentNormalization[] {
  const normalizations: PlanIntentNormalization[] = [];

  if (intent.intent === 'READ_ONLY_ANALYSIS') {
    for (const task of graph.getAllTasks()) {
      const forbidsWildcard = task.contract.forbiddenChanges?.includes('*') ?? false;
      const scopeIsClosed =
        !task.contract.allowedScope ||
        task.contract.allowedScope.length === 0 ||
        task.contract.allowedScope.every((s) => s === '');
      const isMutatingType = task.type === 'implementation' || task.type === 'refactoring';
      const hasMutatingCompletionMode = task.contract.completionMode === 'mutation';

      if (isMutatingType || hasMutatingCompletionMode || !forbidsWildcard || !scopeIsClosed) {
        const originalTaskType = task.type;
        const originalForbiddenChanges = [...(task.contract.forbiddenChanges ?? [])];
        task.type = 'investigation';
        task.contract.allowedScope = [];
        task.contract.forbiddenChanges = Array.from(
          new Set(['*', ...originalForbiddenChanges, ...intent.forbiddenChanges]),
        );
        task.contract.completionMode = 'report';
        task.contract.verification = undefined;

        normalizations.push({
          taskId: task.id,
          originalTaskType,
          normalizedTaskType: 'investigation',
          executionIntent: intent.intent,
          originalForbiddenChanges,
          normalizedForbiddenChanges: [...task.contract.forbiddenChanges],
          reason: `Execution intent is READ_ONLY_ANALYSIS (${intent.reason}) but task was planned as '${originalTaskType}' with a mutable scope; normalized to a read-only investigation.`,
        });
      }
    }

    return normalizations;
  }

  if (intent.forbiddenChanges.length === 0) {
    return normalizations;
  }

  for (const task of graph.getAllTasks()) {
    const originalForbiddenChanges = [...(task.contract.forbiddenChanges ?? [])];
    const mergedForbiddenChanges = Array.from(
      new Set([...originalForbiddenChanges, ...intent.forbiddenChanges]),
    );

    const changed =
      mergedForbiddenChanges.length !== originalForbiddenChanges.length ||
      mergedForbiddenChanges.some((entry, index) => entry !== originalForbiddenChanges[index]);

    if (!changed) continue;

    task.contract.forbiddenChanges = mergedForbiddenChanges;

    normalizations.push({
      taskId: task.id,
      originalTaskType: task.type,
      normalizedTaskType: task.type,
      executionIntent: intent.intent,
      originalForbiddenChanges,
      normalizedForbiddenChanges: mergedForbiddenChanges,
      reason: `Applied run-level scoped no-modification constraints to task contract: ${intent.forbiddenChanges.join(', ')}.`,
    });
  }

  return normalizations;
}
