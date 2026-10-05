import { describe, it, expect } from 'vitest';
import type { Goal } from '@taskforge/core';
import { SemanticPlanner, summarizePlannerFailure } from '../src/index.js';

const goal: Goal = {
  id: 'g',
  description: 'Implement password reset with token expiry, rate limiting and regression tests',
  repository: '/repo',
  constraints: [],
  acceptanceCriteria: [],
  createdAt: new Date(),
};

describe('planner fallback explains itself', () => {
  it('records the provider error when the model call fails', async () => {
    const planner = new SemanticPlanner({
      customCaller: async () => {
        throw new Error('OpenAI planner API failed: HTTP 400: Invalid schema for response_format');
      },
    });
    const graph = await planner.plan(goal);
    const provenance = graph.metadata?.planner as { fallbackReason?: string; fallbackDetail?: string };
    expect(provenance.fallbackReason).toBe('model_unresponsive_or_invalid');
    expect(provenance.fallbackDetail).toContain('HTTP 400');
    expect(provenance.fallbackDetail).toContain('Invalid schema');
  });

  it('records why an unusable plan was rejected', async () => {
    const planner = new SemanticPlanner({ customCaller: async () => ({ summary: 'x', tasks: [] }) as never });
    const graph = await planner.plan(goal);
    const provenance = graph.metadata?.planner as { fallbackDetail?: string };
    expect(provenance.fallbackDetail).toBeTruthy();
  });

  it('adds no detail when no model was configured at all', async () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    const graph = await planner.plan(goal);
    const provenance = graph.metadata?.planner as { fallbackDetail?: string };
    // No model was ever tried, so there is no failure to describe.
    expect(provenance.fallbackDetail).toBeUndefined();
  });
});

describe('summarizePlannerFailure', () => {
  it('masks keys, shortens, and counts the rest', () => {
    const text = summarizePlannerFailure([`bad key sk-abcdef123456 ${'x'.repeat(400)}`, 'second', 'third']);
    expect(text).not.toContain('sk-abcdef123456');
    expect(text).toContain('sk-***');
    expect(text!.length).toBeLessThan(200);
    expect(text).toContain('(+2 more)');
  });

  it('has a plain message when there were no errors', () => {
    expect(summarizePlannerFailure([])).toBe('the model returned no usable plan');
  });
});

describe('a plan longer than the limit is sent back to be combined', () => {
  const rawTask = (i: number, dependencies: string[] = []) => ({
    taskId: `T${i}`,
    title: `Do part ${i}`,
    description: `Part ${i}`,
    type: 'implementation',
    dependencies,
    objective: `Do part ${i}`,
    allowedScope: ['src/**'],
    forbiddenChanges: [],
    acceptanceCriteria: [`part ${i} works`],
    completionMode: 'mutation',
    verification: null,
  });
  const plan = (n: number) => ({
    summary: `${n} tasks`,
    tasks: Array.from({ length: n }, (_, i) => rawTask(i + 1, i === 0 ? [] : [`T${i}`])),
  });

  it('asks the model again with what to do, and takes the shorter plan', async () => {
    const seen: string[] = [];
    let call = 0;
    const planner = new SemanticPlanner({
      maxTasks: 5,
      customCaller: async (messages) => {
        seen.push(messages.map((m) => m.content).join('\n'));
        call += 1;
        return (call === 1 ? plan(8) : plan(4)) as never;
      },
    });
    const graph = await planner.plan(goal);
    expect(graph.getAllTasks()).toHaveLength(4);
    expect(call).toBe(2);
    expect(seen[1]).toContain('exceeds maximum limit (5)');
    expect(seen[1]).toContain('combine related tasks');
    expect(seen[0]).toContain('Prefer 2 to 5 tasks');
  });

  it('does not push a plan that fits', async () => {
    let call = 0;
    const planner = new SemanticPlanner({
      maxTasks: 5,
      customCaller: async () => {
        call += 1;
        return plan(5) as never;
      },
    });
    expect((await planner.plan(goal)).getAllTasks()).toHaveLength(5);
    expect(call).toBe(1);
  });
});

describe('a model plan of the size the planner was asked for is accepted, however long the pasted request', () => {
  const rawTask = (i: number) => ({
    taskId: `T${i}`,
    title: `Do part ${i}`,
    description: `Part ${i}`,
    type: 'implementation',
    dependencies: i === 1 ? [] : [`T${i - 1}`],
    objective: `Do part ${i}`,
    allowedScope: ['src/**'],
    forbiddenChanges: [],
    acceptanceCriteria: [`part ${i} works`],
    completionMode: 'mutation',
    verification: null,
  });

  it('takes 4 tasks for a 48-line paste instead of falling back to a generic plan', async () => {
    const paste = Array.from({ length: 48 }, (_, i) => `Requirement line ${i + 1} describing part of the work`).join('\n');
    let calls = 0;
    const planner = new SemanticPlanner({
      customCaller: async () => {
        calls += 1;
        return { summary: 'four', tasks: [1, 2, 3, 4].map(rawTask) } as never;
      },
    });
    const graph = await planner.plan({ ...goal, description: paste });
    const provenance = graph.metadata?.planner as { source?: string; fallbackReason?: string };
    expect(calls).toBe(1);
    expect(graph.getAllTasks()).toHaveLength(4);
    expect(provenance.fallbackReason).toBeUndefined();
    expect(provenance.source).not.toBe('deterministic_decomposition');
  });

  it('still rejects a plan collapsed into too few tasks for a complex request', async () => {
    const paste = Array.from({ length: 12 }, (_, i) => `Requirement line ${i + 1} describing part of the work`).join('\n');
    const planner = new SemanticPlanner({ customCaller: async () => ({ summary: 'one', tasks: [rawTask(1)] }) as never });
    const graph = await planner.plan({ ...goal, description: paste });
    expect((graph.metadata?.planner as { fallbackReason?: string }).fallbackReason).toBe('model_unresponsive_or_invalid');
  });
});
