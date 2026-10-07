import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentDetector,
  AgentQuotaTracker,
  ClaudeCodeAdapter,
  CodexAdapter,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  type AgentAdapter,
  type AuthStatus,
} from '../src/index.js';

describe('auth status parsers', () => {
  it('reads claude auth status (real output shape)', () => {
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "claude.ai"}')).toEqual({
      state: 'signed_in',
      detail: 'claude.ai',
    });
    expect(parseClaudeAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none"\n}')).toEqual({
      state: 'signed_out',
      signInCommand: 'claude auth login',
    });
  });

  it('does not guess when the output is not understood', () => {
    expect(parseClaudeAuthStatus('boom')).toEqual({ state: 'unknown' });
    expect(parseClaudeAuthStatus('{}')).toEqual({ state: 'unknown' });
    expect(parseCodexLoginStatus('', 1)).toEqual({ state: 'unknown' });
    expect(parseCodexLoginStatus('Logged in using ChatGPT', 1)).toEqual({ state: 'unknown' });
  });

  it('reads codex login status, telling "Not logged in" from "Logged in"', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT\n', 0)).toMatchObject({
      state: 'signed_in',
    });
    expect(parseCodexLoginStatus('Not logged in', 1)).toEqual({
      state: 'signed_out',
      signInCommand: 'codex login',
    });
  });
});

describe('adapters ask the CLI itself', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-auth-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, script: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  };

  it('Claude: runs `auth status --json` and reports signed out', async () => {
    const argsFile = path.join(dir, 'args');
    const bin = fake('claude', `echo "$@" > '${argsFile}'\necho '{"loggedIn": false}'`);
    expect(await new ClaudeCodeAdapter({ binaryPath: bin }).authStatus()).toMatchObject({
      state: 'signed_out',
    });
    expect(fs.readFileSync(argsFile, 'utf8').trim()).toBe('auth status --json');
  });

  it('Codex: runs `login status` and reports signed in', async () => {
    const bin = fake('codex', 'echo "Logged in using ChatGPT"');
    expect(await new CodexAdapter({ binaryPath: bin }).authStatus()).toMatchObject({
      state: 'signed_in',
    });
  });

  it('is unknown, not an error, when the CLI cannot be run', async () => {
    expect(await new CodexAdapter({ binaryPath: path.join(dir, 'missing') }).authStatus()).toEqual({
      state: 'unknown',
    });
  });
});

describe('AgentDetector with sign-in status', () => {
  const agent = (id: string, auth?: () => Promise<AuthStatus>, installed = true): AgentAdapter => ({
    id,
    name: id,
    detect: async () => installed,
    capabilities: async () => ({
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: [],
      tools: [],
    }),
    execute: async () => ({ success: true, message: '', durationMs: 0 }),
    authStatus: auth,
  });

  beforeEach(() => {
    AgentDetector.resetAuthCache();
    AgentQuotaTracker.resetInstance();
  });

  it('does not call a signed-out agent ready, and says how to sign in', async () => {
    const [report] = await AgentDetector.detect([
      agent('claude', async () => ({ state: 'signed_out', signInCommand: 'claude auth login' })),
    ]);
    expect(report).toMatchObject({ ready: false, quotaStatus: 'auth_failed' });
    expect(report.quotaReason).toContain('claude auth login');
  });

  it('keeps signed-in and unknown agents ready (only an explicit "signed out" removes one)', async () => {
    const reports = await AgentDetector.detect([
      agent('a', async () => ({ state: 'signed_in' })),
      agent('b', async () => ({ state: 'unknown' })),
      agent('c'),
    ]);
    expect(reports.map((r) => r.ready)).toEqual([true, true, true]);
  });

  it('does not check sign-in for an agent that is not installed', async () => {
    const auth = vi.fn(async (): Promise<AuthStatus> => ({ state: 'signed_out' }));
    const [report] = await AgentDetector.detect([agent('claude', auth, false)]);
    expect(auth).not.toHaveBeenCalled();
    expect(report).toMatchObject({ ready: false, quotaStatus: 'not_installed' });
  });

  it('remembers the answer briefly, so opening the REPL and running do not each start a process', async () => {
    const auth = vi.fn(async (): Promise<AuthStatus> => ({ state: 'signed_in' }));
    const adapter = agent('codex', auth);
    await AgentDetector.detect([adapter]);
    await AgentDetector.detect([adapter]);
    expect(auth).toHaveBeenCalledTimes(1);
  });
});
