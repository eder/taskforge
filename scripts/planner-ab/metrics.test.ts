import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM module without types
import {
  measurePlan,
  median,
  parseClaudeOutput,
  parseCodexJsonl,
  staticPrefix,
  summarize,
} from './metrics.mjs';

const task = (id: string, scope: string[], mode = 'mutation') => ({
  id,
  contract: { allowedScope: scope, completionMode: mode },
});
const tools = (existing: string[]) => ({
  planWidth: (tasks: unknown[]) => tasks.length,
  dependenciesToSerialize: () => [],
  taskProducesChanges: (t: { contract: { completionMode: string } }) =>
    t.contract.completionMode === 'mutation',
  exists: (p: string) => existing.includes(p),
});

describe('staticPrefix', () => {
  it('cuts at the first wildcard, on a directory boundary', () => {
    expect(staticPrefix('src/storage/**')).toBe('src/storage');
    expect(staticPrefix('src/a.ts')).toBe('src/a.ts');
    expect(staticPrefix('*')).toBeUndefined();
    expect(staticPrefix('**/*.ts')).toBe('');
  });
});

describe('measurePlan', () => {
  it('counts repo-wide scopes and the share of specific scopes that exist', () => {
    const m = measurePlan(
      [
        task('A', ['src/storage/**']),
        task('B', ['src/invented/**']),
        task('C', ['*']),
        task('D', [], 'report'),
      ],
      tools(['src/storage']),
    );
    expect(m).toMatchObject({ tasks: 4, writers: 3, repoWideScopes: 1 });
    expect(m.realScopeRatio).toBeCloseTo(0.5);
  });

  it('has no real-scope ratio when every scope is repository-wide', () => {
    expect(measurePlan([task('A', ['*'])], tools([])).realScopeRatio).toBeUndefined();
  });
});

describe('agent output parsers', () => {
  it('reads a Codex exec --json run (real shape) including tokens', () => {
    const stdout = [
      'Reading additional input from stdin...',
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{\\"ok\\":true}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":15368,"cached_input_tokens":0,"output_tokens":15}}',
    ].join('\n');
    expect(parseCodexJsonl(stdout)).toEqual({ plan: { ok: true }, tokens: 15383 });
  });

  it('fails clearly when Codex returns nothing', () => {
    expect(() => parseCodexJsonl('{"type":"turn.started"}')).toThrow(/no final message/);
  });

  it('reads Claude output from structured_output or from result, and surfaces errors', () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 20,
      output_tokens: 3,
    };
    expect(parseClaudeOutput(JSON.stringify({ structured_output: { a: 1 }, usage }))).toMatchObject(
      { plan: { a: 1 }, tokens: 38 },
    );
    expect(parseClaudeOutput(JSON.stringify({ result: '{"a":2}', usage })).plan).toEqual({ a: 2 });
    expect(() =>
      parseClaudeOutput(JSON.stringify({ is_error: true, result: 'Failed to authenticate' })),
    ).toThrow(/authenticate/);
  });
});

describe('summarize', () => {
  it('averages only the plans the model produced itself', () => {
    const rows = summarize([
      {
        candidate: 'x',
        status: 'model_plan',
        ms: 2000,
        tokens: 100,
        metrics: { tasks: 4, width: 3 },
      },
      {
        candidate: 'x',
        status: 'fallback',
        ms: 4000,
        tokens: 300,
        metrics: { tasks: 2, width: 1 },
      },
    ]);
    expect(rows[0]).toMatchObject({
      calls: 2,
      modelPlans: 1,
      avgTasks: 4,
      avgWidth: 3,
      avgTokens: 200,
    });
    expect(median([3, 1, 2])).toBe(2);
  });

  it('measures the built-in plan for the no-model baseline', () => {
    const rows = summarize([
      { candidate: 'none', status: 'fallback', ms: 5, metrics: { tasks: 3, width: 1 } },
    ]);
    expect(rows[0]).toMatchObject({ modelPlans: 0, avgTasks: 3, avgWidth: 1 });
  });
});
