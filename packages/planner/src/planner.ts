import { RepositoryProfile, Constraint } from '@taskforge/shared';
import { Goal, Task, TaskGraph, Planner } from '@taskforge/core';

export class HeuristicPlanner implements Planner {
  async plan(goal: Goal, profile?: RepositoryProfile): Promise<TaskGraph> {
    const desc = goal.description.toLowerCase();
    const tasks: Task[] = [];
    const now = new Date();

    const isPureExplanation =
      desc.includes('o que esse projeto faz') ||
      desc.includes('o que o projeto faz') ||
      desc.includes('o que este projeto') ||
      desc.includes('o que faz') ||
      desc.includes('o que é') ||
      desc.includes('o que e ') ||
      desc.includes('como funciona') ||
      desc.includes('para que serve') ||
      desc.includes('qual o objetivo') ||
      desc.includes('descreva o projeto') ||
      desc.includes('describe the project') ||
      desc.includes('what does this project do') ||
      desc.includes('what does this repo do') ||
      desc.includes('what is this project') ||
      desc.includes('what does it do') ||
      desc.includes('how does this work') ||
      desc.includes('how does it work') ||
      desc.includes('explain this project') ||
      desc.includes('explain the project') ||
      desc.includes('explique esse projeto') ||
      desc.includes('explique o projeto');

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
      (profile?.frameworks?.some((f) => f.includes('React') || f.includes('Vue') || f.includes('Next')) &&
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
          acceptanceCriteria: ['Comprehensive explanation of project architecture and functionality generated'],
          dependencies: [],
        },
        acceptanceCriteria: ['Explanation provided'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task1);
    } else if (isInvestigationNeeded) {
      const isExplanation = desc.includes('explique') || desc.includes('explain') || desc.includes('entenda');
      // 1. Investigation task
      const task1: Task = {
        id: 'TASK-01',
        goalId: goal.id,
        title: isExplanation ? 'Analyze Architecture and Project Scope' : 'Investigate Root Cause and Architecture',
        description: `Analyze flow and structure related to: ${goal.description}`,
        type: 'investigation',
        status: 'proposed',
        dependencies: [],
        contract: {
          objective: 'Identify root cause, consistency constraints and reproduction path',
          allowedScope: ['src/**'],
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
          allowedScope: ['src/**'],
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
          acceptanceCriteria: ['UI components render and connect to backend', 'Frontend tests pass'],
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
          allowedScope: ['src/**'],
          forbiddenChanges: [],
          acceptanceCriteria: goal.acceptanceCriteria.length > 0 ? goal.acceptanceCriteria : ['Implementation satisfies goal'],
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
          const val = typeof c === 'string' ? (c as string) : (c as Constraint).value ?? JSON.stringify(c);
          t.contract.forbiddenChanges.push(val);
        }
      }
    }

    return new TaskGraph(tasks);
  }
}
