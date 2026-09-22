import { TaskGraph } from '@taskforge/core';
import { ExecutionIntentDecision } from '@taskforge/shared';

export interface PlanIntentNormalization {
  taskId: string;
  originalTaskType: string;
  normalizedTaskType: string;
  executionIntent: ExecutionIntentDecision['intent'];
  reason: string;
  originalForbiddenChanges?: string[];
  normalizedForbiddenChanges?: string[];
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

      if (isMutatingType || !forbidsWildcard || !scopeIsClosed) {
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
