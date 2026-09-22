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

  it('normalizes typecheck baseline into explicit read-only verification semantics', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-BASELINE',
          title: 'Run pnpm typecheck to establish a baseline',
          description: 'Run pnpm typecheck to establish a baseline',
          type: 'testing',
          dependencies: [],
          objective: 'Run pnpm typecheck to establish a baseline',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['Baseline result captured'],
          completionMode: 'verification',
          verification: {
            commands: ['pnpm typecheck'],
            expectation: 'observe',
          },
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-baseline');
    expect(res.valid).toBe(true);

    const contract = res.graph!.getTask('TASK-BASELINE')!.contract;
    expect(contract.completionMode).toBe('verification');
    expect(contract.allowedScope).toEqual([]);
    expect(contract.forbiddenChanges).toEqual(['*']);
    expect(contract.verification).toEqual({
      commands: ['pnpm typecheck'],
      expectation: 'observe',
    });
  });

  it('rejects writable scope on an explicit read-only contract', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-RESEARCH',
          title: 'Inspect current LLMProvider implementation',
          description: 'Inspect the provider abstraction',
          type: 'investigation',
          dependencies: [],
          objective: 'Inspect the provider abstraction',
          allowedScope: ['src/providers/LLMProvider.js'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Findings documented'],
          completionMode: 'report',
          verification: null,
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-research');
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('declares writable allowedScope'))).toBe(true);
  });

  it('rejects paths that are simultaneously allowed and forbidden', () => {
    const raw: RawPlanOutput = {
      tasks: [
        {
          taskId: 'TASK-CONFLICT',
          title: 'Conflicting scope task',
          description: 'Task with inconsistent execution scope',
          type: 'implementation',
          dependencies: [],
          objective: 'Implement provider',
          allowedScope: ['src/providers/LLMProvider.js'],
          forbiddenChanges: ['src/providers/LLMProvider.js'],
          acceptanceCriteria: ['Provider implemented'],
          completionMode: 'mutation',
          verification: null,
        },
      ],
    };

    const res = TaskGraphValidator.validate(raw, 'goal-conflict');
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('both allowed and forbidden'))).toBe(true);
  });
});

describe('SemanticPlanner', () => {
  it('uses the read-only fast path for "O que esse projeto faz?"', async () => {
    const caller = vi.fn().mockRejectedValue(new Error('model should not be called'));
    const planner = new SemanticPlanner({ customCaller: caller, model: 'gpt-5.6-luna' });
    const goal: Goal = {
      id: 'goal-project-overview',
      description: 'O que esse projeto faz?',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    const tasks = graph.getAllTasks();

    expect(caller).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('investigation');
    expect(tasks[0].contract.completionMode).toBe('report');
    expect(tasks[0].contract.allowedScope).toEqual([]);
    expect(tasks[0].contract.forbiddenChanges).toContain('*');
  });

  it('uses a one-task deterministic fast path for a simple repository summary', async () => {
    const caller = vi.fn().mockRejectedValue(new Error('model should not be called'));
    const planner = new SemanticPlanner({ customCaller: caller, model: 'gpt-5.6-luna' });
    const goal: Goal = {
      id: 'goal-summary',
      description: 'Resuma esse projeto para mim',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    const tasks = graph.getAllTasks();

    expect(caller).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('investigation');
    expect(tasks[0].contract.completionMode).toBe('report');
    expect(tasks[0].contract.allowedScope).toEqual([]);
    expect(tasks[0].contract.forbiddenChanges).toContain('*');
    expect(graph.metadata?.planner?.fallbackReason).toBe('lightweight_read_only_fast_path');
  });

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
    expect(graph.metadata!.planner).toBeDefined();
    expect(graph.metadata!.planner.source).toBe('deterministic_decomposition');
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

  it('fails fast to deterministic fallback on non-retryable provider HTTP errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const planner = new SemanticPlanner({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const goal: Goal = {
        id: 'goal-fast-fallback',
        description: 'Implement a provider abstraction and add tests',
        repository: '/fake/repo',
        constraints: [],
        acceptanceCriteria: [],
        createdAt: new Date(),
      };

      const graph = await planner.plan(goal);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(graph.metadata?.planner?.source).not.toBe('semantic_model');
      expect(graph.metadata?.planner?.fallbackReason).toBe('model_unresponsive_or_invalid');
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('rejects generic 2-task proposal for complex cross-cutting goal and falls back to meaningful decomposition', async () => {
    const twoTaskPlan: RawPlanOutput = {
      summary: 'Generic 2-task proposal',
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Core Implementation',
          description: 'Implement all features in a single giant task',
          type: 'implementation',
          dependencies: [],
          objective: 'Implement all features',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Everything works'],
        },
        {
          taskId: 'TASK-02',
          title: 'Verification and Review',
          description: 'Review and verify everything',
          type: 'review',
          dependencies: ['TASK-01'],
          objective: 'Review code',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['Review passes'],
        },
      ],
    };

    const caller = vi.fn().mockResolvedValue(twoTaskPlan);
    const planner = new SemanticPlanner({ customCaller: caller, model: 'test-model' });

    const complexGoal: Goal = {
      id: 'goal-complex-runtime',
      description: [
        'Self-Hosting Dogfood Goal:',
        '- 1. Build an end-to-end task execution pipeline across subsystems.',
        '- 2. Ensure CompletionGate verifies commits before marking success.',
        '- 3. Integrate with Git worktree and clean up branches safely.',
      ].join('\n'),
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(complexGoal);

    // The model proposed only 2 tasks, but policy rejected it and retried
    expect(caller).toHaveBeenCalled();
    expect(caller.mock.calls.length).toBeGreaterThan(1);

    // The plan fell back to meaningful decomposition with >= 3 tasks
    expect(graph.getAllTasks().length).toBeGreaterThanOrEqual(3);

    // Provenance accurately reflects deterministic decomposition, NOT AI model output
    expect(graph.metadata).toBeDefined();
    expect(graph.metadata!.planner).toBeDefined();
    expect(graph.metadata!.planner.source).toBe('deterministic_decomposition');
    expect(graph.metadata!.planner.fallbackReason).toBe('model_unresponsive_or_invalid');
    expect(graph.metadata!.planner.model).toBeUndefined();
  });

  it('accurately records PlannerProvenance across planner sources', async () => {
    // 1. Semantic Model Provenance
    const validFourTaskPlan: RawPlanOutput = {
      summary: 'Valid 4 task plan',
      tasks: [
        { taskId: 'TASK-01', title: 'Task 1', description: 'D1', type: 'investigation', dependencies: [], objective: 'Obj 1', allowedScope: [], forbiddenChanges: ['*'], acceptanceCriteria: ['C1'] },
        { taskId: 'TASK-02', title: 'Task 2', description: 'D2', type: 'architecture', dependencies: ['TASK-01'], objective: 'Obj 2', allowedScope: ['*'], forbiddenChanges: [], acceptanceCriteria: ['C2'] },
        { taskId: 'TASK-03', title: 'Task 3', description: 'D3', type: 'implementation', dependencies: ['TASK-02'], objective: 'Obj 3', allowedScope: ['*'], forbiddenChanges: [], acceptanceCriteria: ['C3'] },
        { taskId: 'TASK-04', title: 'Task 4', description: 'D4', type: 'testing', dependencies: ['TASK-03'], objective: 'Obj 4', allowedScope: ['*'], forbiddenChanges: [], acceptanceCriteria: ['C4'] },
      ],
    };
    const validCaller = vi.fn().mockResolvedValue(validFourTaskPlan);
    const semanticPlanner = new SemanticPlanner({ customCaller: validCaller, model: 'gpt-5.6-luna' });
    const simpleGoal: Goal = {
      id: 'goal-simple',
      description: 'Implement user login',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const semanticGraph = await semanticPlanner.plan(simpleGoal);
    expect(semanticGraph.metadata?.planner).toEqual({
      source: 'semantic_model',
      provider: 'custom',
      model: 'gpt-5.6-luna',
      promptVersion: 'v1.0',
      schemaVersion: 'v1.0',
    });

    // 2. Heuristic Fallback Provenance (no model configured)
    const fallbackPlanner = new SemanticPlanner({ apiKey: undefined, model: 'gpt-5.6-luna' });
    fallbackPlanner.setModelCaller(undefined);
    const heuristicGraph = await fallbackPlanner.plan(simpleGoal);
    expect(heuristicGraph.metadata?.planner).toEqual({
      source: 'heuristic_fallback',
      fallbackReason: 'no_model_configured',
      model: 'gpt-5.6-luna',
      promptVersion: 'v1.0',
      schemaVersion: 'v1.0',
    });
  });
});
