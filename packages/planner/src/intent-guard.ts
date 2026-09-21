import { TaskGraph } from '@taskforge/core';
import { ExecutionIntentDecision } from '@taskforge/shared';

export interface PlanIntentNormalization {
  taskId: string;
  originalTaskType: string;
  normalizedTaskType: string;
  executionIntent: ExecutionIntentDecision['intent'];
  reason: string;
}

/**
 * Second barrier for execution intent (the first is detectExecutionIntent,
 * applied before planning). Even with intent detection in place, a planner
 * (heuristic or semantic) can still produce a task that is inconsistent with
 * the run's authoritative execution intent -- e.g. an 'implementation' task
 * with an open allowedScope under a READ_ONLY_ANALYSIS run. Rather than trust
 * the planner's output, this deterministically corrects any task that
 * disagrees with a READ_ONLY_ANALYSIS intent: downgraded to 'investigation',
 * scope closed, all changes forbidden. Mutates the graph's tasks in place
 * (TaskGraph.getAllTasks() returns live references) and returns a record of
 * every correction made, for PLAN_INTENT_NORMALIZED telemetry.
 */
export function normalizeGraphForExecutionIntent(
  graph: TaskGraph,
  intent: ExecutionIntentDecision,
): PlanIntentNormalization[] {
  const normalizations: PlanIntentNormalization[] = [];

  if (intent.intent !== 'READ_ONLY_ANALYSIS') {
    return normalizations;
  }

  for (const task of graph.getAllTasks()) {
    const forbidsWildcard = task.contract.forbiddenChanges?.includes('*') ?? false;
    const scopeIsClosed =
      !task.contract.allowedScope ||
      task.contract.allowedScope.length === 0 ||
      task.contract.allowedScope.every((s) => s === '');
    const isMutatingType = task.type === 'implementation' || task.type === 'refactoring';

    if (isMutatingType || !forbidsWildcard || !scopeIsClosed) {
      const originalTaskType = task.type;
      task.type = 'investigation';
      task.contract.allowedScope = [];
      task.contract.forbiddenChanges = ['*'];

      normalizations.push({
        taskId: task.id,
        originalTaskType,
        normalizedTaskType: 'investigation',
        executionIntent: intent.intent,
        reason: `Execution intent is READ_ONLY_ANALYSIS (${intent.reason}) but task was planned as '${originalTaskType}' with a mutable scope; normalized to a read-only investigation.`,
      });
    }
  }

  return normalizations;
}
