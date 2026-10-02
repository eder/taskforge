import { describe, it, expect } from 'vitest';
import { runSetup, SETUP_SMOKE_PROMPT, SETUP_SMOKE_BUDGET, type SetupDeps } from '../src/setup.js';

function deps(over: Partial<SetupDeps> = {}) {
  const calls: string[][] = [];
  const asked: string[] = [];
  const log: string[] = [];
  const base: SetupDeps = {
    interactive: true,
    yes: false,
    smoke: true,
    isGitRepo: async () => true,
    hasConfig: () => false,
    readyAgents: async () => ['claude'],
    ask: async (q) => {
      asked.push(q);
      return true;
    },
    runCommand: async (args) => {
      calls.push(args);
    },
    log: (l) => log.push(l),
    ...over,
  };
  return { d: base, calls, asked, log };
}

describe('tf setup', () => {
  it('starts by telling the person there is no sandbox, before anything runs', async () => {
    const { d, calls, log } = deps();
    let marked = false;
    d.noticeShown = () => {
      marked = true;
    };
    await runSetup(d);
    const text = log.join('\n');
    expect(text.indexOf('Before you start')).toBe(0);
    expect(text).toContain('no sandbox');
    expect(text).toContain('container or VM');
    expect(marked).toBe(true);
    expect(calls[0]).toEqual(['doctor']);
  });

  it('walks a new project through doctor, init --check and a capped read-only test task', async () => {
    const { d, calls, asked } = deps();
    const outcome = await runSetup(d);
    expect(outcome.status).toBe('ready');
    expect(calls).toEqual([
      ['doctor'],
      ['init', '--check'],
      ['run', SETUP_SMOKE_PROMPT, '--budget', SETUP_SMOKE_BUDGET],
    ]);
    expect(asked).toHaveLength(2);
    expect(SETUP_SMOKE_PROMPT).toContain('do not change any file');
  });

  it('stops with the exact fix when the folder is not a git repository', async () => {
    const { d, calls, log } = deps({ isGitRepo: async () => false });
    const outcome = await runSetup(d);
    expect(outcome.status).toBe('needs_attention');
    expect(calls).toEqual([]);
    expect(log.join('\n')).toContain('git init');
  });

  it('with no ready agent it still offers the config, skips the test task, and says how to fix it', async () => {
    const { d, calls, log } = deps({ readyAgents: async () => [] });
    const outcome = await runSetup(d);
    expect(outcome.status).toBe('needs_attention');
    expect(calls).toEqual([['doctor'], ['init', '--check']]);
    expect(log.join('\n')).toContain('install and sign in');
  });

  it('keeps an existing config and respects a "no" to the test task', async () => {
    const { d, calls } = deps({ hasConfig: () => true, ask: async () => false });
    const outcome = await runSetup(d);
    expect(outcome.status).toBe('ready');
    expect(calls).toEqual([['doctor']]);
    expect(outcome.steps.find((s) => s.name === 'test task')?.state).toBe('skipped');
  });

  it('--yes accepts the defaults without asking; --no-smoke skips the test task', async () => {
    const yes = deps({ yes: true, ask: async () => { throw new Error('must not ask'); } });
    await runSetup(yes.d);
    expect(yes.calls).toEqual([
      ['doctor'],
      ['init', '--check', '--yes'],
      ['run', SETUP_SMOKE_PROMPT, '--budget', SETUP_SMOKE_BUDGET],
    ]);
    const noSmoke = deps({ yes: true, smoke: false });
    await runSetup(noSmoke.d);
    expect(noSmoke.calls.map((c) => c[0])).toEqual(['doctor', 'init']);
  });

  it('without a terminal and without --yes it asks nothing and changes nothing', async () => {
    const { d, calls } = deps({ interactive: false, ask: async () => { throw new Error('must not ask'); } });
    const outcome = await runSetup(d);
    expect(calls).toEqual([['doctor']]);
    expect(outcome.steps.map((s) => s.state)).toEqual(['done', 'skipped', 'skipped']);
  });
});
