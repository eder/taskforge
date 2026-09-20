import { describe, it, expect, vi } from 'vitest';
import { Goal } from '@taskforge/core';
import {
  SemanticPlanner,
  TaskGraphValidator,
  RawPlanOutput,
} from '../src/index.js';

describe('TaskGraphValidator', () => {
  it('validates a correct semantic plan output', () => {
    const raw: RawPlanOutput = {
      summary: 'Auth feature',
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Design Auth Architecture',
          description: 'Design authentication token and session schema',
          type: 'architecture',
          dependencies: [],
          objective: 'Design schema',
          allowedScope: ['packages/auth/*'],
          forbiddenChanges: ['package.json'],
          acceptanceCriteria: ['Architecture documented'],
        },
        {
          taskId: 'TASK-02',
          title: 'Implement Auth Endpoints',
          description: 'Implement JWT signing and validation handlers',
          type: 'implementation',
          dependencies: ['TASK-01'],
          objective: 'Implement JWT endpoints',
          allowedScope: ['packages/auth/*'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Endpoints return 200 on valid credentials'],
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-1');
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.graph).toBeDefined();
    expect(res.graph!.getAllTasks()).toHaveLength(2);
  });

  it('rejects duplicate task IDs', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Task A',
          description: 'Desc A',
          type: 'implementation',
          dependencies: [],
          objective: 'Obj A',
          acceptanceCriteria: ['Done A'],
        },
        {
          taskId: 'TASK-01',
          title: 'Task B',
          description: 'Desc B',
          type: 'implementation',
          dependencies: [],
          objective: 'Obj B',
          acceptanceCriteria: ['Done B'],
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-1');
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Duplicate task ID'))).toBe(true);
  });

  it('rejects non-existent dependencies', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Task A',
          description: 'Desc A',
          type: 'implementation',
          dependencies: ['TASK-99'],
          objective: 'Obj A',
          acceptanceCriteria: ['Done A'],
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-1');
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('non-existent dependency'))).toBe(true);
  });

  it('rejects self dependencies', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Task A',
          description: 'Desc A',
          type: 'implementation',
          dependencies: ['TASK-01'],
          objective: 'Obj A',
          acceptanceCriteria: ['Done A'],
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-1');
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('self-dependency'))).toBe(true);
  });

  it('rejects cyclic dependencies in DAG', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Task A',
          description: 'Desc A',
          type: 'implementation',
          dependencies: ['TASK-02'],
          objective: 'Obj A',
          acceptanceCriteria: ['Done A'],
        },
        {
          taskId: 'TASK-02',
          title: 'Task B',
          description: 'Desc B',
          type: 'implementation',
          dependencies: ['TASK-01'],
          objective: 'Obj B',
          acceptanceCriteria: ['Done B'],
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-1');
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Cyclic dependency'))).toBe(true);
  });

  it('rejects empty acceptance criteria or invalid types', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Task A',
          description: 'Desc A',
          type: 'invalid_type_here',
          dependencies: [],
          objective: 'Obj A',
          acceptanceCriteria: [],
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-1');
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('invalid type'))).toBe(true);
    expect(res.errors.some((e) => e.includes('acceptance criterion'))).toBe(true);
  });
});

describe('SemanticPlanner', () => {
  it('Requirement 6: decomposes complex goal into meaningful semantic TaskGraph', async () => {
    const planner = new SemanticPlanner();
    const goal: Goal = {
      id: 'goal-complex',
      description:
        'Improve team-aware concurrency, enforce maxAgentsPerTask, fix assignment identity, make governed execution exception-safe, clean team worktrees, implement independent review, connect CommunicationBus, fix session routing and support emergent collaboration.',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    const tasks = graph.getAllTasks();

    // A semantic plan must NOT reduce this complex goal to a generic 2-task plan!
    expect(tasks.length).toBeGreaterThan(2);
    expect(tasks.length).toBeLessThanOrEqual(20);

    // Verify structural decomposition and dependencies
    const sorted = graph.topologicalSort();
    expect(sorted.length).toBe(tasks.length);

    // Verify provenance is recorded
    expect(graph.metadata).toBeDefined();
    expect(graph.metadata!.source).toBe('semantic');
  });

  it('Requirement 5: falls back safely to deterministic planning when model output is invalid', async () => {
    const invalidCaller = vi.fn().mockResolvedValue({
      summary: 'Broken output',
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Cycle 1',
          description: 'Desc 1',
          type: 'implementation',
          dependencies: ['TASK-02'],
          objective: 'Obj 1',
          acceptanceCriteria: ['Criterion 1'],
        },
        {
          taskId: 'TASK-02',
          title: 'Cycle 2',
          description: 'Desc 2',
          type: 'implementation',
          dependencies: ['TASK-01'], // Cyclic!
          objective: 'Obj 2',
          acceptanceCriteria: ['Criterion 2'],
        },
      ],
    });

    const planner = new SemanticPlanner({ customCaller: invalidCaller });
    const goal: Goal = {
      id: 'goal-fallback',
      description: 'Implement simple endpoint',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    expect(graph.getAllTasks().length).toBeGreaterThan(0);
    // Verified fallback provenance
    expect(graph.metadata).toBeDefined();
    expect(graph.metadata!.source).toBe('fallback');
    expect(graph.metadata!.fallbackReason).toBe('model_unresponsive_or_invalid');
  });

  it('Requirement 3: revises existing plan with typed revisions without creating new goal', async () => {
    const planner = new SemanticPlanner();
    const goal: Goal = {
      id: 'goal-base',
      description: 'Refactor the runtime engine and improve performance',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const initialGraph = await planner.plan(goal);
    expect(initialGraph.getAllTasks().length).toBeGreaterThan(0);

    // 1. User says: "also make sure assignmentId is never treated as sessionId"
    const revised1 = await planner.revise(initialGraph, goal, {
      revisionType: 'general_feedback',
      feedback: 'also make sure assignmentId is never treated as sessionId',
    });

    expect(revised1.metadata?.revised).toBe(true);
    for (const t of revised1.getAllTasks()) {
      expect(
        t.contract.objective.includes('assignmentId is never treated as sessionId') ||
          t.contract.acceptanceCriteria.some((c) => c.includes('assignmentId is never treated as sessionId')),
      ).toBe(true);
    }

    // 2. User says: "Don't modify the Delivery Gate"
    const revised2 = await planner.revise(revised1, goal, {
      revisionType: 'add_constraint',
      feedback: "Don't modify the Delivery Gate",
      details: { forbiddenScope: 'packages/integration/src/delivery-gate.ts' },
    });

    for (const t of revised2.getAllTasks()) {
      expect(t.contract.forbiddenChanges).toContain(
        'packages/integration/src/delivery-gate.ts',
      );
    }

    // 3. User says: "Add another verification task"
    const revised3 = await planner.revise(revised2, goal, {
      revisionType: 'add_task',
      feedback: 'Add another verification task',
    });

    expect(revised3.getAllTasks().length).toBe(revised2.getAllTasks().length + 1);
    const lastTask = revised3.getAllTasks()[revised3.getAllTasks().length - 1];
    expect(lastTask.type).toBe('testing');
  });
});
