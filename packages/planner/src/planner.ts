import {
  RepositoryProfile,
  Constraint,
  PlannerProvenance,
  isLightweightReadOnlyRequest,
  isAdvisoryReadOnlyRequest,
} from '@taskforge/shared';
import { Goal, Task, TaskGraph, Planner } from '@taskforge/core';

export function isPureExplanationGoal(description: string): boolean {
  return isLightweightReadOnlyRequest(description) || isAdvisoryReadOnlyRequest(description);
}

export function requiresArchitectureBoundaryDecision(description: string): boolean {
  const text = description.toLowerCase();

  // A single keyword such as "cache" or "backend" is not enough to force an
  // architecture task. We only escalate when the request combines multiple
  // concerns that make ownership/source-of-truth a real design decision.
  const statefulMechanism =
    /\b(cache|caching|state|session|queue|storage|store|persistence|persist|materialized\s+view|read\s+model|replica|snapshot|estado|sess[aã]o|fila|armazenamento|persist[eê]ncia)\b/i.test(text);
  const consistencyLifecycle =
    /\b(invalidat|reactiv|event(?:-driven)?|freshness|stale|sync|synchroni[sz]|consisten|source\s+of\s+truth|refresh|recompute|ttl|evento|reativ|sincroni[sz]|consist[eê]ncia|fonte\s+da\s+verdade|atualiza[cç][aã]o)\b/i.test(text);
  const layerBoundary =
    /\b(frontend|backend|client|server|app|mobile|desktop|browser|api|gateway|service|worker|database|db|cliente|servidor|aplicativo|camada|servi[cç]o|banco)\b/i.test(text);
  const explicitDesignQuestion =
    /\b(architecture|architect|design|boundary|ownership|owner|responsib|where\s+(?:it|this)\s+should|where\s+should|source\s+of\s+truth|arquitetura|desenho|fronteira|responsabil|onde\s+deveria|onde\s+deve|deveria\s+ficar|deve\s+ficar)\b/i.test(text);

  // A user mentioning an app screen describes where the behavior is observed,
  // not necessarily where the mechanism must live. Only treat ownership as
  // already resolved when the request explicitly locates the mechanism itself.
  const explicitMechanismOwnership =
    /\b(?:implement|create|add|keep|store|place|put|implementar|implemente|criar|crie|adicionar|adicione|manter|armazenar|colocar)\b[^.\n]{0,80}\b(?:cache|state|session|queue|storage|store|persistence|read\s+model|snapshot|estado|sess[aã]o|fila|armazenamento|persist[eê]ncia)\b[^.\n]{0,60}\b(?:inside|within|in|on|no|na|dentro\s+do|dentro\s+da)\b[^.\n]{0,30}\b(?:backend|frontend|client|server|app|mobile|desktop|browser|api|gateway|service|worker|database|db|cliente|servidor|aplicativo|camada|servi[cç]o|banco)\b/i.test(text) ||
    /\b(?:cache|state|session|queue|storage|store|persistence|read\s+model|snapshot|estado|sess[aã]o|fila|armazenamento|persist[eê]ncia)\b[^.\n]{0,40}\b(?:belongs\s+in|lives\s+in|owned\s+by|fica\s+no|fica\s+na|deve\s+ficar\s+no|deve\s+ficar\s+na)\b[^.\n]{0,30}\b(?:backend|frontend|client|server|app|api|gateway|service|database|db|cliente|servidor|aplicativo|camada|servi[cç]o|banco)\b/i.test(text);

  if (explicitMechanismOwnership && !explicitDesignQuestion) {
    return false;
  }

  const signalCount = [
    statefulMechanism,
    consistencyLifecycle,
    layerBoundary,
    explicitDesignQuestion,
  ].filter(Boolean).length;

  return signalCount >= 3;
}

export function isLightweightGoal(description: string): boolean {
  const desc = description.toLowerCase();
  const lightweightPatterns = [
    /\breadme(\.md)?\b/i,
    /\b(docs?|documentation)\b/i,
    /\b(markdown|\.md)\b/i,
    /\b(license)\b/i,
    /\b(typo|translate)\b/i,
    /\b(changelog|contributing)\b/i,
  ];

  if (!lightweightPatterns.some((pattern) => pattern.test(desc))) {
    return false;
  }

  // "Lightweight" must mean the goal is primarily documentation/content work,
  // not merely that a larger engineering objective happens to mention docs.
  // Keep this fallback conservative: when semantic planning is unavailable,
  // it is safer to produce the normal implementation/review plan than collapse
  // a cross-cutting feature into a single "Documentation and Content Update".

  const engineeringTargets =
    /\b(provider|api|planner|router|runtime|control\s+plane|architecture|abstraction|interface|configuration|config|health|provenance|fallback|integration|scheduler|database|schema)\b/i;
  const engineeringActions =
    /\b(implement|build|create|introduce|support|refactor|fix|repair|migrate|extract|design|implementar|implemente|criar|crie|adicionar|adicione|corrigir|corrija|refatorar|refatore|migrar|extraia|extrair)\b/i;

  // Look for an affirmative engineering action in a clause that is not simply
  // a documentation instruction. This catches goals such as "create a
  // pluggable provider architecture ... update the README" while preserving
  // genuine requests like "update README to document the provider config".
  const clauses = description
    .split(/[.!?;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  const hasNonDocumentationEngineeringWork = clauses.some((clause) => {
    const lower = clause.toLowerCase();
    const isDocumentationClause = lightweightPatterns.some((pattern) => pattern.test(lower));
    return !isDocumentationClause && engineeringActions.test(lower) && engineeringTargets.test(lower);
  });

  return !hasNonDocumentationEngineeringWork;
}

export class HeuristicPlanner implements Planner {
  async plan(goal: Goal, profile?: RepositoryProfile): Promise<TaskGraph> {
    const desc = goal.description.toLowerCase();
    const tasks: Task[] = [];
    const now = new Date();

    const isPureExplanation = isPureExplanationGoal(goal.description);
    const isLightweight = isLightweightGoal(goal.description);
    const needsArchitectureDecision = requiresArchitectureBoundaryDecision(goal.description);

    const isInvestigationNeeded =
      isPureExplanation ||
      desc.includes('investigate') ||
      desc.includes('bug') ||
      desc.includes('duplicate') ||
      desc.includes('flaky') ||
      desc.includes('reproduce') ||
      desc.includes('explain') ||
      desc.includes('analyze') ||
      desc.includes('audit') ||
      desc.includes('understand');

    const isFullStack =
      (desc.includes('frontend') && desc.includes('backend')) ||
      (profile?.frameworks?.some(
        (f) => f.includes('React') || f.includes('Vue') || f.includes('Next'),
      ) &&
        (desc.includes('auth') || desc.includes('oauth') || desc.includes('endpoint')));

    if (isPureExplanation) {
      const task1: Task = {
        id: 'TASK-01',
        goalId: goal.id,
        title: 'Analyze Architecture and Project Scope',
        description: `Analyze flow, purpose and architecture related to: ${goal.description}`,
        type: 'investigation',
        status: 'proposed',
        dependencies: [],
        contract: {
          objective: `Analyze repository and explain to user: ${goal.description}`,
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: [
            'Comprehensive explanation of project architecture and functionality generated',
          ],
          dependencies: [],
        },
        acceptanceCriteria: ['Explanation provided'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task1);
    } else if (isLightweight) {
      const task1: Task = {
        id: 'TASK-01',
        goalId: goal.id,
        title: 'Documentation and Content Update',
        description: goal.description,
        type: 'implementation',
        status: 'proposed',
        dependencies: [],
        contract: {
          objective: goal.description,
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria:
            goal.acceptanceCriteria.length > 0
              ? goal.acceptanceCriteria
              : ['Documentation or content updated as requested'],
          dependencies: [],
        },
        acceptanceCriteria: ['Documentation or content updated as requested'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task1);
    } else if (needsArchitectureDecision) {
      // The request contains an unresolved ownership/source-of-truth decision
      // across stateful mechanisms, consistency lifecycle and system layers.
      // Resolve that boundary before allowing an implementation agent to choose
      // a location by convenience.
      const architectureTask: Task = {
        id: 'TASK-01',
        goalId: goal.id,
        title: 'Resolve Architecture Boundary and Consistency Model',
        description: `Inspect the existing data flow and decide the correct ownership boundary before implementation: ${goal.description}`,
        type: 'architecture',
        status: 'proposed',
        dependencies: [],
        contract: {
          objective:
            'Determine the authoritative owner, source of truth, layer boundary and consistency lifecycle before implementation',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: [
            'Current data flow and existing ownership are identified from the repository',
            'Authoritative source of truth and owning layer are explicitly decided',
            'Invalidation, refresh, synchronization or event lifecycle is defined',
            'Identity, tenant, privacy and security boundaries are considered where applicable',
            'Implementation constraints and affected components are stated for the next task',
          ],
          dependencies: [],
        },
        acceptanceCriteria: [
          'Architecture boundary is explicit before implementation begins',
        ],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      const implementationTask: Task = {
        id: 'TASK-02',
        goalId: goal.id,
        title: 'Implement Against the Architecture Decision',
        description: `Implement the requested behavior using the architecture decision from TASK-01: ${goal.description}`,
        type: 'implementation',
        status: 'proposed',
        dependencies: ['TASK-01'],
        contract: {
          objective: goal.description,
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria:
            goal.acceptanceCriteria.length > 0
              ? [...goal.acceptanceCriteria, 'Implementation follows the architecture decision from TASK-01']
              : [
                  'Implementation satisfies goal',
                  'Implementation follows the architecture decision from TASK-01',
                ],
          dependencies: ['TASK-01'],
        },
        acceptanceCriteria: [
          'Implementation satisfies goal and preserves the selected ownership boundary',
        ],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      const reviewTask: Task = {
        id: 'TASK-03',
        goalId: goal.id,
        title: 'Architecture and Correctness Review',
        description:
          'Verify the implementation respects the architecture decision, consistency lifecycle, privacy boundaries and original goal',
        type: 'review',
        status: 'proposed',
        dependencies: ['TASK-02'],
        contract: {
          objective:
            'Independently review architecture compliance, correctness, consistency and security/privacy boundaries',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: [
            'Implementation matches the architecture decision',
            'Zero critical or major review findings',
          ],
          dependencies: ['TASK-02'],
        },
        acceptanceCriteria: ['Approved by reviewer with no blocking findings'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      tasks.push(architectureTask, implementationTask, reviewTask);
    } else if (isInvestigationNeeded) {
      const isExplanation = desc.includes('explain') || desc.includes('understand');
      // 1. Investigation task
      const task1: Task = {
        id: 'TASK-01',
        goalId: goal.id,
        title: isExplanation
          ? 'Analyze Architecture and Project Scope'
          : 'Investigate Root Cause and Architecture',
        description: `Analyze flow and structure related to: ${goal.description}`,
        type: 'investigation',
        status: 'proposed',
        dependencies: [],
        contract: {
          objective: 'Identify root cause, consistency constraints and reproduction path',
          allowedScope: ['*'],
          forbiddenChanges: ['package.json'],
          acceptanceCriteria: ['Root cause documented', 'Failing test or trace evidence collected'],
          dependencies: [],
        },
        acceptanceCriteria: ['Root cause identified without modifying business contract'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task1);

      // 2. Implementation task
      const task2: Task = {
        id: 'TASK-02',
        goalId: goal.id,
        title: 'Implement Fix and Prevention Tests',
        description: `Apply targeted fix based on investigation for: ${goal.description}`,
        type: 'implementation',
        status: 'proposed',
        dependencies: ['TASK-01'],
        contract: {
          objective: 'Implement fix preventing recurrence',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Fix applied', 'Unit and regression tests pass'],
          dependencies: ['TASK-01'],
        },
        acceptanceCriteria: ['Regression test passing', 'Contract maintained'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task2);

      // 3. Review task
      const task3: Task = {
        id: 'TASK-03',
        goalId: goal.id,
        title: 'Independent Code and Security Review',
        description: 'Review diff for edge cases and regressions',
        type: 'review',
        status: 'proposed',
        dependencies: ['TASK-02'],
        contract: {
          objective: 'Independent review of implementation',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['Zero critical or major review findings'],
          dependencies: ['TASK-02'],
        },
        acceptanceCriteria: ['Approved by reviewer'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task3);
    } else if (isFullStack) {
      // Backend first, then frontend, then review
      const task1: Task = {
        id: 'TASK-01',
        goalId: goal.id,
        title: 'Backend Implementation',
        description: `Implement backend service for: ${goal.description}`,
        type: 'implementation',
        status: 'proposed',
        dependencies: [],
        contract: {
          objective: 'Backend service and API endpoints',
          allowedScope: ['src/backend/**', 'server/**', 'api/**'],
          forbiddenChanges: ['src/frontend/**'],
          acceptanceCriteria: ['API endpoints respond as expected', 'Backend tests pass'],
          dependencies: [],
        },
        acceptanceCriteria: ['Backend API operational'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      const task2: Task = {
        id: 'TASK-02',
        goalId: goal.id,
        title: 'Frontend Implementation',
        description: `Implement UI components for: ${goal.description}`,
        type: 'implementation',
        status: 'proposed',
        dependencies: ['TASK-01'],
        contract: {
          objective: 'Frontend user interface',
          allowedScope: ['src/frontend/**', 'client/**', 'components/**'],
          forbiddenChanges: ['src/backend/**'],
          acceptanceCriteria: [
            'UI components render and connect to backend',
            'Frontend tests pass',
          ],
          dependencies: ['TASK-01'],
        },
        acceptanceCriteria: ['Frontend operational'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      const task3: Task = {
        id: 'TASK-03',
        goalId: goal.id,
        title: 'Integration and Independent Review',
        description: 'Review end-to-end integration and API compatibility',
        type: 'review',
        status: 'proposed',
        dependencies: ['TASK-02'],
        contract: {
          objective: 'Full-stack review',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['Verified integration', 'No regression'],
          dependencies: ['TASK-02'],
        },
        acceptanceCriteria: ['Integration review approved'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      tasks.push(task1, task2, task3);
    } else {
      // Standard feature: Implementation + Review
      const task1: Task = {
        id: 'TASK-01',
        goalId: goal.id,
        title: 'Core Implementation',
        description: goal.description,
        type: 'implementation',
        status: 'proposed',
        dependencies: [],
        contract: {
          objective: goal.description,
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria:
            goal.acceptanceCriteria.length > 0
              ? goal.acceptanceCriteria
              : ['Implementation satisfies goal'],
          dependencies: [],
        },
        acceptanceCriteria: ['Implementation satisfies goal'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      const task2: Task = {
        id: 'TASK-02',
        goalId: goal.id,
        title: 'Verification and Review',
        description: `Review changes for: ${goal.description}`,
        type: 'review',
        status: 'proposed',
        dependencies: ['TASK-01'],
        contract: {
          objective: 'Code review and validation',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['No critical defects'],
          dependencies: ['TASK-01'],
        },
        acceptanceCriteria: ['Review completed'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      tasks.push(task1, task2);
    }

    // Propagate goal-level constraints to all tasks
    if (goal.constraints && goal.constraints.length > 0) {
      for (const t of tasks) {
        for (const c of goal.constraints) {
          const val =
            typeof c === 'string' ? (c as string) : ((c as Constraint).value ?? JSON.stringify(c));
          t.contract.forbiddenChanges.push(val);
        }
      }
    }

    // Heuristic planning is also normalized to the same explicit completion
    // contract used by semantic plans. CompletionGate should not have to infer
    // whether a task is expected to mutate the repository.
    for (const task of tasks) {
      if (!task.contract.completionMode) {
        if (task.type === 'implementation' || task.type === 'refactoring') {
          task.contract.completionMode = 'mutation';
        } else if (task.type === 'review') {
          task.contract.completionMode = 'review';
        } else {
          task.contract.completionMode = 'report';
        }
      }

      if (task.contract.completionMode !== 'mutation') {
        task.contract.allowedScope = [];
        task.contract.forbiddenChanges = Array.from(
          new Set(['*', ...(task.contract.forbiddenChanges ?? [])]),
        );
      }
    }

    const graph = new TaskGraph(tasks);
    const plannerMeta: PlannerProvenance = {
      source: 'heuristic_fallback',
      fallbackReason: 'heuristic_planner',
      promptVersion: 'v1.0',
      schemaVersion: 'v1.0',
    };
    graph.metadata = {
      planner: plannerMeta,
      source: 'heuristic',
    };
    return graph;
  }
}

