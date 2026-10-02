import { describe, it, expect } from 'vitest';
import { SemanticPlanner } from '../src/semantic-planner.js';

const candidates = [
  { id: 'run-1', goal: 'Analyse', age: '1h ago', excerpt: '1. Fix retry' },
  { id: 'run-2', goal: 'Other', age: '2h ago', excerpt: 'x' },
];

describe('SemanticPlanner.selectEarlierRun', () => {
  it('returns the chosen id, null, or rejects ids that were not offered', async () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    planner.setEarlierRunSelector(async () => ({ earlierRunId: 'run-2' }));
    expect(await planner.selectEarlierRun('1番をやって', candidates)).toBe('run-2');
    planner.setEarlierRunSelector(async () => ({ earlierRunId: null }));
    expect(await planner.selectEarlierRun('anything', candidates)).toBeNull();
    planner.setEarlierRunSelector(async () => ({ earlierRunId: 'run-404' }));
    expect(await planner.selectEarlierRun('anything', candidates)).toBeNull();
  });

  it('treats the earlier output as untrusted data and the request as language-agnostic', async () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    let system = '';
    planner.setEarlierRunSelector(async (messages) => {
      system = messages[0].content;
      return { earlierRunId: null };
    });
    await planner.selectEarlierRun('hola', candidates);
    expect(system).toContain('any language');
    expect(system).toContain('untrusted');
  });

  it('returns undefined when the model fails or is unavailable, so the caller can fall back', async () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    expect(planner.canSelectEarlierRun()).toBe(false);
    expect(await planner.selectEarlierRun('x', candidates)).toBeUndefined();
    planner.setEarlierRunSelector(async () => {
      throw new Error('boom');
    });
    expect(await planner.selectEarlierRun('x', candidates)).toBeUndefined();
  });
});
