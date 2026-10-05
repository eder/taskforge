import { describe, expect, it } from 'vitest';
import { type Task, TaskGraph } from '@taskforge/core';
import { enforceArchitectureBoundaryDecision } from '../src/negotiator.js';

function task(
  id: string,
  type: Task['type'],
  dependencies: string[],
  mode: 'report' | 'mutation',
): Task {
  return {
    id,
    goalId: 'goal',
    title: `Persist state behind the api: ${id}`,
    description: 'Decide the server layer that owns the persisted state and the events that sync it',
    type,
    status: 'proposed',
    dependencies,
    contract: {
      objective: 'Persisted state, events and the api layer boundary',
      allowedScope: mode === 'mutation' ? ['src/**'] : [],
      forbiddenChanges: mode === 'mutation' ? [] : ['*'],
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

describe('enforceArchitectureBoundaryDecision', () => {
  it('adds the decision when the plan has none', () => {
    const graph = new TaskGraph([task('IMPL', 'implementation', [], 'mutation')]);
    expect(enforceArchitectureBoundaryDecision(graph).changed).toBe(true);
    expect(graph.getAllTasks()).toHaveLength(2);
  });

  it('does not repeat an architecture decision the plan already puts before the mutation', () => {
    const graph = new TaskGraph([
      task('DESIGN', 'architecture', [], 'report'),
      task('IMPL', 'implementation', ['DESIGN'], 'mutation'),
      task('MORE', 'implementation', ['IMPL'], 'mutation'),
    ]);
    expect(enforceArchitectureBoundaryDecision(graph).changed).toBe(false);
    expect(graph.getAllTasks()).toHaveLength(3);
  });

  it('still adds it when some mutating work does not wait for the plan\'s own decision', () => {
    const graph = new TaskGraph([
      task('DESIGN', 'architecture', [], 'report'),
      task('IMPL', 'implementation', ['DESIGN'], 'mutation'),
      task('OTHER', 'implementation', [], 'mutation'),
    ]);
    expect(enforceArchitectureBoundaryDecision(graph).changed).toBe(true);
  });
});
