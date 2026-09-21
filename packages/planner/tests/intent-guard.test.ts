import { describe, it, expect } from 'vitest';
import { detectExecutionIntent } from '@taskforge/shared';
import { Goal } from '@taskforge/core';
import { HeuristicPlanner } from '../src/planner.js';
import { normalizeGraphForExecutionIntent } from '../src/intent-guard.js';

describe('normalizeGraphForExecutionIntent', () => {
  it('downgrades a planner-produced implementation task to investigation when the run intent is READ_ONLY_ANALYSIS', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-1',
      description: 'In the root of this project I need to update the content of README.md do this',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };
    const graph = await planner.plan(goal);
    expect(graph.getAllTasks()[0].type).toBe('implementation');

    const intent = detectExecutionIntent(
      'DO NOT update README.md. Just tell me if the content of README.md needs changes.',
    );
    expect(intent.intent).toBe('READ_ONLY_ANALYSIS');

    const normalizations = normalizeGraphForExecutionIntent(graph, intent);

    expect(normalizations).toHaveLength(1);
    expect(normalizations[0].originalTaskType).toBe('implementation');
    expect(normalizations[0].normalizedTaskType).toBe('investigation');

    const task = graph.getAllTasks()[0];
    expect(task.type).toBe('investigation');
    expect(task.contract.allowedScope).toEqual([]);
    expect(task.contract.forbiddenChanges).toEqual(['*']);
  });

  it('leaves the graph untouched when the run intent is IMPLEMENTATION without scoped restrictions', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-2',
      description: 'Update the README to document the new health endpoint',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };
    const graph = await planner.plan(goal);
    const intent = detectExecutionIntent(goal.description);
    expect(intent.intent).toBe('IMPLEMENTATION');

    const normalizations = normalizeGraphForExecutionIntent(graph, intent);

    expect(normalizations).toHaveLength(0);
    expect(graph.getAllTasks()[0].type).toBe('implementation');
    expect(graph.getAllTasks()[0].contract.allowedScope).toEqual(['*']);
  });

  it('propagates scoped no-modification constraints into every planned task without downgrading implementation', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-3',
      description: 'Implement /health and add tests. Do not modify the Delivery Gate.',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    const intent = detectExecutionIntent(goal.description);

    expect(intent.intent).toBe('IMPLEMENTATION');
    expect(intent.forbiddenChanges).toEqual(['Delivery Gate']);

    const normalizations = normalizeGraphForExecutionIntent(graph, intent);
    const tasks = graph.getAllTasks();

    expect(normalizations).toHaveLength(tasks.length);
    expect(tasks.every((task) => task.type !== 'investigation' || task.title !== 'Core Implementation')).toBe(
      true,
    );
    expect(tasks.every((task) => task.contract.forbiddenChanges.includes('Delivery Gate'))).toBe(
      true,
    );
    expect(tasks.every((task) => task.contract.allowedScope.includes('*'))).toBe(true);
  });

  it('merges run-level scoped restrictions with planner-provided forbidden changes', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-4',
      description: 'Fix the scheduler. Do not modify package.json.',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    graph.getAllTasks()[0].contract.forbiddenChanges = ['README.md'];

    const intent = detectExecutionIntent(goal.description);
    normalizeGraphForExecutionIntent(graph, intent);

    expect(graph.getAllTasks()[0].contract.forbiddenChanges).toEqual([
      'README.md',
      'package.json',
    ]);
  });

  it('does not duplicate a scoped restriction if the planner already preserved it', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-5',
      description: 'Fix the scheduler. Do not modify package.json.',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    for (const task of graph.getAllTasks()) {
      task.contract.forbiddenChanges = ['package.json'];
    }

    const intent = detectExecutionIntent(goal.description);
    const normalizations = normalizeGraphForExecutionIntent(graph, intent);

    expect(normalizations).toHaveLength(0);
    expect(
      graph.getAllTasks().every((task) => task.contract.forbiddenChanges.join(',') === 'package.json'),
    ).toBe(true);
  });

  it('does not re-flag a task that is already a closed-scope investigation under READ_ONLY_ANALYSIS', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-6',
      description: 'Please explain how the scheduler assigns agents to tasks.',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };
    const graph = await planner.plan(goal);
    const intent = detectExecutionIntent(goal.description);
    expect(intent.intent).toBe('READ_ONLY_ANALYSIS');

    normalizeGraphForExecutionIntent(graph, intent);
    const secondPass = normalizeGraphForExecutionIntent(graph, intent);
    expect(secondPass).toHaveLength(0);
  });
});
