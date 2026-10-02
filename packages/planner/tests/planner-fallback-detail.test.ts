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
