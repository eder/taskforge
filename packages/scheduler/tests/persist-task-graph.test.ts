import { describe, expect, it } from 'vitest';
import {
  GoalRepository,
  RunRepository,
  TaskForgeDatabase,
  TaskRepository,
} from '@taskforge/persistence';
import { TaskGraph, type Task } from '@taskforge/core';
import { persistTaskGraph } from '../src/run-orchestrator.js';

function task(id: string, dependencies: string[] = []): Task {
  return {
    id,
    goalId: 'goal',
    title: `Do ${id}`,
    description: id,
    type: 'implementation',
    status: 'accepted',
    dependencies,
    contract: {
      objective: id,
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: [`${id} done`],
      dependencies,
    },
    acceptanceCriteria: [`${id} done`],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('persistTaskGraph', () => {
  it('stores a plan that lists a prerequisite after the tasks that depend on it', () => {
    const db = new TaskForgeDatabase(':memory:');
    const goal = new GoalRepository(db).create({
      id: 'goal',
      description: 'goal',
      repository: '/tmp/x',
    });
    new RunRepository(db).create('run-1', goal.id);
    const tasks = new TaskRepository(db);

    // T7 is a decision the others rely on, but the planner listed it last.
    const graph = new TaskGraph([task('T1', ['T7']), task('T2', ['T1', 'T7']), task('T7')]);
    expect(() => persistTaskGraph(tasks, graph, 'run-1', goal.id)).not.toThrow();

    const stored = tasks.listByRun('run-1');
    expect(stored.map((t) => t.id).sort()).toEqual(['T1', 'T2', 'T7']);
    expect(stored.find((t) => t.id === 'T2')?.dependencies?.sort()).toEqual(['T1', 'T7']);
    db.close();
  });
});
