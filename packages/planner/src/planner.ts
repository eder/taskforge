import { RepositoryProfile, Constraint } from '@taskforge/shared';
import { Goal, Task, TaskGraph, Planner } from '@taskforge/core';

export function isPureExplanationGoal(description: string): boolean {
  const desc = description
    .toLowerCase()
    .replace(/[?!.,;:]+/g, ' ')
    .trim();

  // Actionable verbs imply code modification
  const hasActionVerb =
    /\b(create|build|implement|add|make|fix|repair|patch|refactor|remove|delete|update|cria|criar|adicione|adicionar|construa|construir|implemente|implementar|faça|fazer|corrige|corrigir|refatore|refatorar|delete|deletar|remova|remover|atualize|atualizar)\b/i.test(
      desc,
    );
  if (hasActionVerb) {
    return false;
  }

  const explanationPatterns = [
    /what\s+(does\s+|is\s+)?(this\s+|the\s+)?(project|repo|repository|codebase|app|application|system)?\s*(do|does|is|about)/i,
    /what\s+(is|are)\s+(this\s+|the\s+)?(project|repo|repository|codebase|app|application|system)/i,
    /what\s+does\s+it\s+do/i,
    /how\s+(does\s+)?(this\s+|the\s+)?(project|repo|repository|codebase|app|system|it)\s+(work|works|operate|function)/i,
    /(explain|describe|overview|tell\s+me\s+about)\s+(this\s+|the\s+)?(project|repo|repository|codebase|app|system|architecture)/i,
    /o\s+que\s+(esse\s+|este\s+|o\s+)?(projeto|repo|repositório|sistema|app|código)?\s*(faz|é|e)/i,
    /o\s+que\s+faz\s+(esse\s+|este\s+|o\s+)?(projeto|repo|repositório|sistema|app)/i,
    /como\s+(funciona|opera)\s+(esse\s+|este\s+|o\s+)?(projeto|repo|repositório|sistema|app)/i,
    /como\s+(esse\s+|este\s+|o\s+)?(projeto|repo|repositório|sistema|app)\s+(funciona|opera)/i,
    /(explique|explica|descreva|descreve|fale\s+sobre|entenda|entender)\s+(o\s+|esse\s+|este\s+)?(projeto|repo|repositório|código|sistema|app)/i,
    /para\s+que\s+serve\s+(esse\s+|este\s+|o\s+)?(projeto|repo|repositório|sistema|app)/i,
    /qual\s+(o\s+)?(objetivo|propósito)\s+(desse\s+|deste\s+|do\s+)?(projeto|repo|repositório)/i,
  ];

  return explanationPatterns.some((pattern) => pattern.test(desc));
}

export function isLightweightGoal(description: string): boolean {
  const desc = description.toLowerCase();
  const lightweightPatterns = [
    /\breadme(\.md)?\b/i,
    /\b(docs?|documentation|documenta[çc][ãa]o)\b/i,
    /\b(markdown|\.md)\b/i,
    /\b(license|licen[çc]a)\b/i,
    /\b(typo|translate|tradu[zç]|traduzir)\b/i,
    /\b(changelog|contributing)\b/i,
  ];
  return lightweightPatterns.some((pattern) => pattern.test(desc));
}

export class HeuristicPlanner implements Planner {
  async plan(goal: Goal, profile?: RepositoryProfile): Promise<TaskGraph> {
    const desc = goal.description.toLowerCase();
    const tasks: Task[] = [];
    const now = new Date();

    const isPureExplanation = isPureExplanationGoal(goal.description);
    const isLightweight = isLightweightGoal(goal.description);

    const isInvestigationNeeded =
      isPureExplanation ||
      desc.includes('investiga') ||
      desc.includes('investigate') ||
      desc.includes('bug') ||
      desc.includes('duplica') ||
      desc.includes('flaky') ||
      desc.includes('reproduce') ||
      desc.includes('explique') ||
      desc.includes('explain') ||
      desc.includes('analis') ||
      desc.includes('analyz') ||
      desc.includes('audit') ||
      desc.includes('entenda') ||
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
    } else if (isInvestigationNeeded) {
      const isExplanation =
        desc.includes('explique') || desc.includes('explain') || desc.includes('entenda');
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

    return new TaskGraph(tasks);
  }
}
