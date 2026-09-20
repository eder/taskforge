import { describe, it, expect } from 'vitest';
import { TaskGraph } from '../src/task-graph.js';
import { Task, TaskStateMachine } from '../src/models.js';
import { InvalidTaskGraphError } from '@taskforge/shared';

function createMockTask(
  id: string,
  dependencies: string[] = [],
  status: TaskStatus = 'accepted',
): Task {
  return {
    id,
    goalId: 'goal-1',
    title: `Task ${id}`,
    description: `Description of ${id}`,
    type: 'implementation',
    status,
    dependencies,
    contract: {
      objective: `Objective ${id}`,
      allowedScope: [],
      forbiddenChanges: [],
      acceptanceCriteria: [],
      dependencies,
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Core - TaskGraph and State Machine', () => {
  it('detects cycles and throws InvalidTaskGraphError', () => {
    const taskA = createMockTask('TASK-A', ['TASK-B']);
    const taskB = createMockTask('TASK-B', ['TASK-A']);

    expect(() => new TaskGraph([taskA, taskB])).toThrow(InvalidTaskGraphError);
  });

  it('detects missing dependencies', () => {
    const taskA = createMockTask('TASK-A', ['NON_EXISTENT']);
    expect(() => new TaskGraph([taskA])).toThrow(InvalidTaskGraphError);
  });

  it('computes topological sort for valid DAG', () => {
    const taskA = createMockTask('TASK-A', []);
    const taskB = createMockTask('TASK-B', ['TASK-A']);
    const taskC = createMockTask('TASK-C', ['TASK-B']);

    const graph = new TaskGraph([taskC, taskA, taskB]);
    const order = graph.getTopologicalOrder().map((t) => t.id);

    expect(order.indexOf('TASK-A')).toBeLessThan(order.indexOf('TASK-B'));
    expect(order.indexOf('TASK-B')).toBeLessThan(order.indexOf('TASK-C'));
  });

  it('returns runnable tasks based on dependency verification', () => {
    const taskA = createMockTask('TASK-A', [], 'accepted');
    const taskB = createMockTask('TASK-B', [], 'accepted');
    const taskC = createMockTask('TASK-C', ['TASK-A', 'TASK-B'], 'accepted');

    const graph = new TaskGraph([taskA, taskB, taskC]);

    // Initially A and B are runnable, C is waiting
    let runnable = graph.getRunnableTasks().map((t) => t.id);
    expect(runnable).toContain('TASK-A');
    expect(runnable).toContain('TASK-B');
    expect(runnable).not.toContain('TASK-C');

    // Mark A verified, B still running/not verified
    graph.updateTaskStatus('TASK-A', 'ready');
    graph.updateTaskStatus('TASK-A', 'assigned');
    graph.updateTaskStatus('TASK-A', 'running');
    graph.updateTaskStatus('TASK-A', 'completed');
    graph.updateTaskStatus('TASK-A', 'verification');
    graph.updateTaskStatus('TASK-A', 'verified');

    runnable = graph.getRunnableTasks().map((t) => t.id);
    expect(runnable).not.toContain('TASK-C'); // still waiting for B

    // Mark B verified
    graph.updateTaskStatus('TASK-B', 'ready');
    graph.updateTaskStatus('TASK-B', 'assigned');
    graph.updateTaskStatus('TASK-B', 'running');
    graph.updateTaskStatus('TASK-B', 'completed');
    graph.updateTaskStatus('TASK-B', 'verification');
    graph.updateTaskStatus('TASK-B', 'verified');

    // Now C is runnable!
    runnable = graph.getRunnableTasks().map((t) => t.id);
    expect(runnable).toContain('TASK-C');
  });

  it('validates state transitions with TaskStateMachine', () => {
    const task = createMockTask('TASK-1', [], 'proposed');
    const next = TaskStateMachine.transition(task, 'preflight');
    expect(next.status).toBe('preflight');

    expect(() => TaskStateMachine.transition(task, 'integrated')).toThrow(InvalidTaskGraphError);
  });

  it('computes direct and transitive dependents accurately', () => {
    const root = createMockTask('ROOT', []);
    const mid1 = createMockTask('MID-1', ['ROOT']);
    const mid2 = createMockTask('MID-2', ['ROOT']);
    const leaf = createMockTask('LEAF', ['MID-1']);
    const independent = createMockTask('INDEP', []);

    const graph = new TaskGraph([root, mid1, mid2, leaf, independent]);

    const directOfRoot = graph.getDirectDependents('ROOT').map((t) => t.id);
    expect(directOfRoot).toHaveLength(2);
    expect(directOfRoot).toContain('MID-1');
    expect(directOfRoot).toContain('MID-2');

    const transitiveOfRoot = graph.getTransitiveDependents('ROOT').map((t) => t.id);
    expect(transitiveOfRoot).toHaveLength(3);
    expect(transitiveOfRoot).toContain('MID-1');
    expect(transitiveOfRoot).toContain('MID-2');
    expect(transitiveOfRoot).toContain('LEAF');

    expect(graph.getTransitiveDependents('LEAF')).toHaveLength(0);
    expect(graph.getTransitiveDependents('INDEP')).toHaveLength(0);
  });
});
