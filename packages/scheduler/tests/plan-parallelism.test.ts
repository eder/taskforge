import { describe, expect, it } from 'vitest';
import { TaskGraph, type Task } from '@taskforge/core';
import {
  dependenciesToSerialize,
  planWidth,
  scopesOverlap,
  serializeOverlappingTasks,
} from '../src/plan-parallelism.js';

function task(
  id: string,
  scope: string[],
  dependencies: string[] = [],
  mode: 'mutation' | 'report' = 'mutation',
): Task {
  return {
    id,
    goalId: 'goal',
    title: id,
    description: id,
    type: mode === 'report' ? 'architecture' : 'implementation',
    status: 'proposed',
    dependencies,
    contract: {
      objective: id,
      allowedScope: mode === 'report' ? [] : scope,
      forbiddenChanges: mode === 'report' ? ['*'] : [],
      acceptanceCriteria: ['done'],
      dependencies,
      completionMode: mode,
    },
    acceptanceCriteria: ['done'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('scopesOverlap', () => {
  it('tells apart different directories and files', () => {
    expect(scopesOverlap(['src/db/**'], ['src/api/**'])).toBe(false);
    expect(scopesOverlap(['src/db/**', 'tests/db/**'], ['src/api/**'])).toBe(false);
    expect(scopesOverlap(['src/a.py'], ['src/b.py'])).toBe(false);
  });

  it('treats a directory and what is inside it as the same files', () => {
    expect(scopesOverlap(['src/**'], ['src/api/**'])).toBe(true);
    expect(scopesOverlap(['src/api/routes.py'], ['src/api/**'])).toBe(true);
    expect(scopesOverlap(['src/*.py'], ['src/api/**'])).toBe(true);
  });

  it('does not mistake a shared name prefix for a shared directory', () => {
    expect(scopesOverlap(['src/api/**'], ['src/api_v2/**'])).toBe(false);
  });

  it('is conservative when a scope is unknown or repository-wide', () => {
    expect(scopesOverlap([], ['src/**'])).toBe(true);
    expect(scopesOverlap(['**'], ['src/**'])).toBe(true);
    expect(scopesOverlap(['*'], ['docs/**'])).toBe(true);
  });
});

describe('serializing tasks that may write the same files', () => {
  it('leaves tasks with separate files to run together', () => {
    const tasks = [task('DB', ['src/db/**']), task('API', ['src/api/**'])];
    expect(dependenciesToSerialize(tasks)).toEqual([]);
    expect(planWidth(tasks)).toBe(2);
  });

  it('orders tasks that share files', () => {
    const tasks = [task('A', ['src/**']), task('B', ['src/api/**'])];
    expect(dependenciesToSerialize(tasks)).toEqual([{ taskId: 'B', after: 'A' }]);
    expect(planWidth(tasks)).toBe(1);
  });

  it('does not add an order between tasks that are already ordered', () => {
    const tasks = [task('A', ['src/**']), task('B', ['src/**'], ['A'])];
    expect(dependenciesToSerialize(tasks)).toEqual([]);
  });

  it('ignores read-only tasks', () => {
    const tasks = [task('DESIGN', [], [], 'report'), task('IMPL', ['src/**'])];
    expect(dependenciesToSerialize(tasks)).toEqual([]);
    expect(planWidth(tasks)).toBe(2);
  });

  it('updates the graph and keeps it valid', () => {
    const graph = new TaskGraph([task('A', ['src/**']), task('B', ['src/api/**']), task('C', ['docs/**'])]);
    expect(serializeOverlappingTasks(graph)).toEqual([{ taskId: 'B', after: 'A' }]);
    expect(graph.getTask('B')?.dependencies).toEqual(['A']);
    expect(graph.getTask('B')?.contract.dependencies).toEqual(['A']);
    expect(graph.getTask('C')?.dependencies).toEqual([]);
  });

  it('counts the widest layer of a plan', () => {
    const tasks = [
      task('DESIGN', [], [], 'report'),
      task('DB', ['src/db/**'], ['DESIGN']),
      task('API', ['src/api/**'], ['DESIGN']),
      task('DOCS', ['docs/**'], ['DESIGN']),
      task('VERIFY', [], ['DB', 'API', 'DOCS'], 'report'),
    ];
    expect(planWidth(tasks)).toBe(3);
  });
});
