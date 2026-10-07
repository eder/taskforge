import { beforeEach, describe, expect, it } from 'vitest';
import {
  AgentDetector,
  AgentQuotaTracker,
  looksLikeAuthFailure,
  type AgentAdapter,
  type AgentQuotaStore,
} from '../src/index.js';

describe('looksLikeAuthFailure', () => {
  it('does not mistake TaskForge\'s own contract, or code that says "forbidden", for a sign-in problem', () => {
    expect(looksLikeAuthFailure('{"allowedScope":["src/"],"forbiddenChanges":["*"]}')).toBe(false);
    expect(
      looksLikeAuthFailure('// access is forbidden for guests\nthrow new ForbiddenError()'),
    ).toBe(false);
    expect(looksLikeAuthFailure('the user is unauthorized to view this page')).toBe(false);
    expect(looksLikeAuthFailure('Individual quota reached')).toBe(false);
  });

  it('recognizes real sign-in failures', () => {
    for (const text of [
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'error: authentication failed',
      'HTTP 403 Forbidden',
      '401 Unauthorized',
      'Unauthorized (status 401)',
      'Invalid API key provided',
      'Incorrect API key provided: sk-...',
      '{"type":"authentication_error"}',
      'Not logged in. Please run login',
    ]) {
      expect(looksLikeAuthFailure(text), text).toBe(true);
    }
  });

  it('only reads the end of the output, where a provider error is, not the prompt echoed at the start', () => {
    const echoed = `Failed to authenticate\n${'x'.repeat(5000)}\ntask finished with an unrelated test failure`;
    expect(looksLikeAuthFailure(echoed)).toBe(false);
    expect(looksLikeAuthFailure(`${'x'.repeat(5000)}\nFailed to authenticate`)).toBe(true);
  });
});

describe('AgentQuotaTracker authentication failures', () => {
  const MIN = 60_000;
  let store: AgentQuotaStore & { rows: Map<string, ReturnType<AgentQuotaStore['list']>[number]> };

  beforeEach(() => {
    AgentQuotaTracker.resetInstance();
    AgentDetector.resetAuthCache();
    const rows = new Map<string, ReturnType<AgentQuotaStore['list']>[number]>();
    store = {
      rows,
      list: () => [...rows.values()],
      upsert: (r) => void rows.set(r.agentId, r),
      delete: (id) => void rows.delete(id),
    };
  });

  it('a failed run that merely echoes `forbiddenChanges` does not take the agent out of use', () => {
    const tracker = AgentQuotaTracker.getInstance();
    const failedRunOutput = 'running task\n{"forbiddenChanges":["*"]}\nnpm test failed: 3 tests';
    expect(tracker.recordFailure('agy', failedRunOutput)).toBe(false);
    expect(tracker.isAvailable('agy')).toBe(true);
  });

  it('a recorded authentication failure blocks, then the agent is tried again after the retry delay', () => {
    const tracker = AgentQuotaTracker.getInstance();
    const now = Date.now();
    tracker.recordFailure('claude', 'Failed to authenticate', now - 10 * MIN);
    expect(tracker.isAvailable('claude')).toBe(false);

    AgentQuotaTracker.resetInstance();
    const later = AgentQuotaTracker.getInstance();
    later.recordFailure('claude', 'Failed to authenticate', now - 31 * MIN);
    expect(later.isAvailable('claude')).toBe(true);
  });

  it('a stale authentication failure already saved on disk, with no expiry, is dropped when loaded', () => {
    store.rows.set('agy', {
      agentId: 'agy',
      status: 'auth_failed',
      reason: 'old',
      recordedAt: Date.now() - 12 * 60 * MIN,
      source: 'runtime',
    });
    store.rows.set('codex', {
      agentId: 'codex',
      status: 'auth_failed',
      reason: 'recent',
      recordedAt: Date.now() - 2 * MIN,
      source: 'runtime',
    });

    const tracker = AgentQuotaTracker.getInstance();
    tracker.configureStore(store);

    expect(tracker.isAvailable('agy')).toBe(true);
    expect(store.rows.has('agy')).toBe(false);
    expect(tracker.isAvailable('codex')).toBe(false);
  });

  it('a failure set by hand does not expire by itself', () => {
    store.rows.set('agy', {
      agentId: 'agy',
      status: 'auth_failed',
      reason: 'set by me',
      recordedAt: Date.now() - 24 * 60 * MIN,
      source: 'manual',
    });
    const tracker = AgentQuotaTracker.getInstance();
    tracker.configureStore(store);
    expect(tracker.isAvailable('agy')).toBe(false);
  });

  it('a sign-in check that says "signed in" clears a recorded authentication failure, but not a quota one', async () => {
    const tracker = AgentQuotaTracker.getInstance();
    tracker.configureStore(store);
    tracker.recordFailure('claude', 'Failed to authenticate');
    tracker.recordFailure('codex', 'Individual quota reached');
    const signedIn = (id: string): AgentAdapter => ({
      id,
      name: id,
      detect: async () => true,
      authStatus: async () => ({ state: 'signed_in' }),
      capabilities: async () => ({
        canRead: true,
        canWrite: true,
        canExecute: true,
        languages: [],
        tools: [],
      }),
      execute: async () => ({ success: true, message: '', durationMs: 0 }),
    });

    const reports = await AgentDetector.detect([signedIn('claude'), signedIn('codex')]);

    expect(reports.find((r) => r.id === 'claude')).toMatchObject({ ready: true });
    expect(reports.find((r) => r.id === 'codex')).toMatchObject({
      ready: false,
      quotaStatus: 'quota_exhausted',
    });
    expect(store.rows.has('claude')).toBe(false);
  });
});
