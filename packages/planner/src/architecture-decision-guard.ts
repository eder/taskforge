import { ExecutionIntentDecision } from '@taskforge/shared';
import { Goal, Task, TaskGraph } from '@taskforge/core';

export interface ArchitectureDecisionInvariantResult {
  graph: TaskGraph;
  changed: boolean;
  insertedTask: boolean;
  decisionTaskId?: string;
  reason?: string;
}

const STATEFUL_MECHANISM =
  /\b(cache|caching|cached|snapshot|materiali[sz]ed(?:\s+view)?|replica|state|storage|persist(?:ence|ed|ing)?|queue|broker|session)\b/i;

const CONSISTENCY_SEMANTICS =
  /\b(invalidat\w*|reactiv\w*|event(?:-driven)?|events?|evento\w*|fresh\w*|stale|sync\w*|consisten\w*|source\s+of\s+truth|authoritative|ttl|refresh|atualiza\w*)\b/i;

const SYSTEM_BOUNDARY =
  /\b(app|mobile|ios|android|client|frontend|backend|server|api|gateway|service|screen|home|tela|camada|device|browser|desktop|worker)\b/i;

const EXPLICIT_PLACEMENT =
  /(?:cache|snapshot|state|materiali[sz]ed(?:\s+view)?)\s+(?:on|in|at|no|na|do|da)\s+(?:the\s+)?(?:backend|server|client|frontend|app|device)|(?:backend|server|client|frontend|app|device)[-\s]+(?:side\s+)?(?:cache|snapshot|state|materiali[sz]ed(?:\s+view)?)/i;

function isMutationTask(task: Task): boolean {
  return (
    task.contract.completionMode === 'mutation' ||
    task.type === 'implementation' ||
    task.type === 'refactoring'
  );
}

function isReadOnlyDecisionTask(task: Task): boolean {
  const readOnly =
    task.contract.completionMode === 'report' ||
    task.contract.forbiddenChanges?.includes('*');
  return readOnly && (task.type === 'architecture' || task.type === 'investigation');
}

function nextDecisionTaskId(tasks: Task[]): string {
  const used = new Set(tasks.map((task) => task.id));
  for (let i = 1; i < 100; i++) {
    const id = `TASK-ARCH-${String(i).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  return `TASK-ARCH-${Date.now()}`;
}

export function needsArchitectureBoundaryDecision(description: string): boolean {
  return (
    STATEFUL_MECHANISM.test(description) &&
    CONSISTENCY_SEMANTICS.test(description) &&
    SYSTEM_BOUNDARY.test(description) &&
    !EXPLICIT_PLACEMENT.test(description)
  );
}

/**
 * Architecture-boundary invariant.
 *
 * Some implementation requests describe a stateful consistency mechanism
 * (cache/event invalidation/snapshot/sync) at a UI/service boundary without
 * deciding which layer owns the authoritative state. Coding immediately in
 * that situation turns an unresolved architecture choice into an accidental
 * implementation decision.
 *
 * The invariant inserts (or reuses) a read-only architecture decision task and
 * makes every mutating task depend on it. It is intentionally conservative:
 * explicit placement such as "cache in the backend" is treated as a resolved
 * boundary and is not second-guessed.
 */
export function enforceArchitectureDecisionPlanInvariant(
  graph: TaskGraph,
  goal: Goal,
  executionIntent: ExecutionIntentDecision,
): ArchitectureDecisionInvariantResult {
  if (!executionIntent.mutationAllowed || !needsArchitectureBoundaryDecision(goal.description)) {
    return { graph, changed: false, insertedTask: false };
  }

  const originalTasks = graph.getAllTasks();
  const mutationTasks = originalTasks.filter(isMutationTask);
  if (mutationTasks.length === 0) {
    return { graph, changed: false, insertedTask: false };
  }

  let decisionTask = originalTasks.find(isReadOnlyDecisionTask);
  let insertedTask = false;

  if (!decisionTask) {
    insertedTask = true;
    const now = new Date();
    const decisionTaskId = nextDecisionTaskId(originalTasks);
    decisionTask = {
      id: decisionTaskId,
      goalId: goal.id,
      title: 'Resolve Architecture Boundary Before Implementation',
      description:
        'Inspect the current repository and resolve ownership, consistency, and invalidation boundaries before mutation.',
      type: 'architecture',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: [
          'Inspect the current repository before implementation.',
          'Decide which layer owns the authoritative state/read model for the requested behavior.',
          'Define client/backend responsibilities, event-driven invalidation or refresh semantics, and freshness guarantees.',
          'Identify identity/security boundaries affected by persisted or cached data.',
          'Return one concrete architecture decision with rationale and implementation guidance for dependent tasks.',
          `Original request: ${goal.description}`,
        ].join(' '),
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: [
          'Current source of truth and read path identified',
          'Authoritative ownership/placement decision stated explicitly',
          'Invalidation, refresh, and freshness semantics defined',
          'Identity/security boundary implications considered',
          'Concrete implementation guidance provided for downstream tasks',
        ],
        dependencies: [],
        completionMode: 'report',
        metadata: {
          architectureDecisionInvariant: true,
          reason: 'stateful consistency behavior crosses an unresolved application/service boundary',
        },
      },
      acceptanceCriteria: [
        'Architecture ownership and consistency boundary resolved before implementation',
      ],
      reworkCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  let dependencyChanged = false;
  const decisionTaskId = decisionTask.id;
  const rewritten = originalTasks.map((task) => {
    if (!isMutationTask(task) || task.id === decisionTaskId) return { ...task };

    const dependencies = task.dependencies.includes(decisionTaskId)
      ? [...task.dependencies]
      : [decisionTaskId, ...task.dependencies];
    if (dependencies.length !== task.dependencies.length) dependencyChanged = true;

    const contractDependencies = task.contract.dependencies?.includes(decisionTaskId)
      ? [...task.contract.dependencies]
      : [decisionTaskId, ...(task.contract.dependencies ?? [])];

    return {
      ...task,
      dependencies,
      contract: {
        ...task.contract,
        dependencies: contractDependencies,
        metadata: {
          ...(task.contract.metadata ?? {}),
          requiresArchitectureDecision: decisionTaskId,
        },
      },
    };
  });

  if (!insertedTask && !dependencyChanged) {
    return {
      graph,
      changed: false,
      insertedTask: false,
      decisionTaskId,
    };
  }

  const tasks = insertedTask ? [decisionTask, ...rewritten] : rewritten;
  const hardened = new TaskGraph(tasks, {
    ...(graph.metadata ?? {}),
    architectureDecisionInvariant: {
      enforced: true,
      decisionTaskId,
      insertedTask,
    },
  });

  return {
    graph: hardened,
    changed: true,
    insertedTask,
    decisionTaskId,
    reason:
      'Stateful consistency behavior crosses an unresolved application/service boundary; architecture ownership must be resolved before mutation.',
  };
}
