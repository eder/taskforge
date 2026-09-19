import { describe, it, expect } from 'vitest';
import { HeuristicPlanner } from '../src/planner.js';
import { Goal } from '@taskforge/core';

describe('HeuristicPlanner', () => {
  it('creates a structured task graph from a goal', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-1',
      description: 'Implement user authentication with JWT and tests',
      repository: '/fake/repo',
      constraints: ['Do not use cookies', 'Keep tokens short-lived'],
      acceptanceCriteria: ['Tests pass', 'Auth works'],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    const tasks = graph.getAllTasks();

    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.contract).toBeDefined();
      expect(task.contract.objective).toBeDefined();
      expect(task.contract.allowedScope).toBeInstanceOf(Array);
      expect(task.contract.forbiddenChanges).toBeInstanceOf(Array);
      expect(task.contract.forbiddenChanges).toContain('Do not use cookies');
      expect(task.contract.acceptanceCriteria).toBeInstanceOf(Array);
    }

    // Check topological sort passes with no cycles
    const sorted = graph.topologicalSort();
    expect(sorted.length).toBe(tasks.length);
    expect(tasks[0].contract.allowedScope).toContain('*');
  });

  it('creates a single-task DAG with wildcard scope for documentation / README tasks', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-2',
      description:
        'Na raiz desse projeto eu preciso mudar o conteudo README.MD para ingles faça isso',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    const tasks = graph.getAllTasks();

    expect(tasks.length).toBe(1);
    expect(tasks[0].type).toBe('implementation');
    expect(tasks[0].contract.allowedScope).toEqual(['*']);
    expect(tasks[0].contract.forbiddenChanges).toEqual([]);
  });
});
