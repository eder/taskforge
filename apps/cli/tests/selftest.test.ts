import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import type { AgentAdapter } from '@taskforge/agents';
import { runSelftest, type SelftestDeps } from '../src/selftest.js';

function deps(over: Partial<SelftestDeps> = {}) {
  const log: string[] = [];
  const base: SelftestDeps = {
    fake: true,
    budget: 150_000,
    keep: false,
    readyAgents: async () => [],
    createAgent: () => undefined,
    log: (l) => log.push(l),
    ...over,
  };
  return { d: base, log };
}

describe('tf selftest', () => {
  it('walks the whole pipeline with the fake agent: worktree, edit, verification, integration, apply, undo', async () => {
    const { d, log } = deps();
    const result = await runSelftest(d);
    expect(result.passed).toBe(true);
    expect(result.stages.map((s) => s.state)).toEqual(Array(6).fill('passed'));
    expect(result.stages.map((s) => s.name)).toEqual([
      'agent',
      'sandbox project',
      'agent run (isolated worktree, edit, verification, integration)',
      'independent check of the delivered branch',
      'apply to the target branch',
      'undo the applied run',
    ]);
    expect(log.join('\n')).toContain('The whole pipeline works on this machine');
    expect(result.sandbox).toBeUndefined(); // cleaned up
  }, 120_000);

  it('keeps the sandbox on request', async () => {
    const { d } = deps({ keep: true });
    const result = await runSelftest(d);
    expect(result.sandbox && fs.existsSync(result.sandbox)).toBe(true);
    fs.rmSync(result.sandbox!, { recursive: true, force: true });
  }, 120_000);

  it('with no agent installed it stops at the first stage with what to install, and runs nothing else', async () => {
    const { d, log } = deps({ fake: false });
    const result = await runSelftest(d);
    expect(result.passed).toBe(false);
    expect(result.stages[0]).toMatchObject({ name: 'agent', state: 'failed' });
    expect(result.stages[0].hint).toContain('tf selftest --fake');
    expect(result.stages.slice(1).every((s) => s.state === 'skipped')).toBe(true);
    expect(log.join('\n')).toContain('did not pass');
  });

  it('names the stage that failed when the agent cannot do the work, and says what to try', async () => {
    const broken: AgentAdapter = {
      id: 'broken',
      name: 'Broken Agent',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] }),
      execute: async () => ({ success: false, message: 'Failed to authenticate: OAuth session expired', durationMs: 1 }),
    };
    const { d, log } = deps({
      fake: false,
      readyAgents: async () => [{ id: 'broken', name: 'Broken Agent' }],
      createAgent: () => broken,
    });
    const result = await runSelftest(d);
    expect(result.passed).toBe(false);
    const failed = result.stages.find((s) => s.state === 'failed')!;
    expect(failed.name).toContain('agent run');
    expect(result.stages.filter((s) => s.state === 'skipped').length).toBeGreaterThanOrEqual(3);
    expect(log.join('\n')).toContain('Failed to authenticate: OAuth session expired'); // the real cause, not "completed=0"
    expect(log.join('\n')).toContain('not signed in');
  }, 120_000);

  it('picks the requested agent, and says so when it is not ready', async () => {
    const { d } = deps({ fake: false, agentId: 'codex', readyAgents: async () => [{ id: 'claude', name: 'Claude Code' }] });
    const result = await runSelftest(d);
    expect(result.stages[0].detail).toContain('Agent "codex" is not installed and ready');
  });

  it('explains a refused write with what TaskForge does about it, not a generic message', async () => {
    const refused: AgentAdapter = {
      id: 'refused',
      name: 'Refused Agent',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] }),
      execute: async () => ({ success: false, message: "I couldn't create greet.js: the write was denied because write permission hasn't been granted", durationMs: 1 }),
    };
    const { d, log } = deps({ fake: false, readyAgents: async () => [{ id: 'refused', name: 'Refused Agent' }], createAgent: () => refused });
    const result = await runSelftest(d);
    expect(result.stages.find((s) => s.state === 'failed')?.hint).toContain('not allowed to write');
    expect(log.join('\n')).toContain('·'); // progress is shown while the agent works
  }, 120_000);
});
