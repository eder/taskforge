import { describe, it, expect } from 'vitest';
import { detectExecutionIntent } from '@taskforge/shared';
import { Goal } from '@taskforge/core';
import { HeuristicPlanner } from '../src/planner.js';
import { normalizeGraphForExecutionIntent } from '../src/intent-guard.js';

describe('normalizeGraphForExecutionIntent', () => {
  it('downgrades a planner-produced implementation task to investigation when the run intent is READ_ONLY_ANALYSIS', async () => {
    // The planner's own keyword heuristics would happily classify this as an
    // 'implementation' task with an open scope purely because "README"/
    // "update" appear in the text -- exactly the bug the spec describes. The
    // Intent Guard is the second, authoritative barrier that must correct it
    // regardless of what the planner decided.
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
    expect(graph.getAllTasks()[0].type).toBe('implementation'); // sanity: planner really did misclassify

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

  it('leaves the graph untouched when the run intent is IMPLEMENTATION', async () => {
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

  it('does not re-flag a task that is already a closed-scope investigation under READ_ONLY_ANALYSIS', async () => {
    const planner = new HeuristicPlanner();
    const goal: Goal = {
      id: 'goal-3',
      description: 'Please explain how the scheduler assigns agents to tasks.',
      repository: '/fake/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };
    const graph = await planner.plan(goal);
    const intent = detectExecutionIntent(goal.description);
    expect(intent.intent).toBe('READ_ONLY_ANALYSIS');

    // First pass normalizes (or confirms) the graph.
    normalizeGraphForExecutionIntent(graph, intent);
    // A second pass over the now-normalized graph must be a no-op.
    const secondPass = normalizeGraphForExecutionIntent(graph, intent);
    expect(secondPass).toHaveLength(0);
  });
});
