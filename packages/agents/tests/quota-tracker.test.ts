import { describe, it, expect, beforeEach } from 'vitest';
import { AgentQuotaTracker } from '../src/quota-tracker.js';
import { AgentDetector } from '../src/agent-registry.js';
import { FakeAgent } from '../src/fake-agent.js';

describe('AgentQuotaTracker and Quota-Aware Detection', () => {
  beforeEach(() => {
    AgentQuotaTracker.resetInstance();
  });

  it('detects usage limit / quota exhaustion from agent output and parses reset time', () => {
    const tracker = AgentQuotaTracker.getInstance();
    const output =
      "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:42 PM.";

    const detected = tracker.recordFailure('codex', output);
    expect(detected).toBe(true);

    const status = tracker.getQuotaStatus('codex');
    expect(status.status).toBe('quota_exhausted');
    expect(status.reason).toContain('cooldown until 1:42 PM');
    expect(status.resetAt).toBeInstanceOf(Date);
    expect(tracker.isAvailable('codex')).toBe(false);
  });

  it('detects rate limits with retry seconds', () => {
    const tracker = AgentQuotaTracker.getInstance();
    const output = '429 Rate limit exceeded. Please try again in 45 seconds.';

    const detected = tracker.recordFailure('claude', output);
    expect(detected).toBe(true);

    const status = tracker.getQuotaStatus('claude');
    expect(status.status).toBe('rate_limited');
    expect(status.reason).toBe('retry in 45s');
    expect(tracker.isAvailable('claude')).toBe(false);
  });

  it('parses Google Antigravity/Gemini "Resets in HhMmSs" quota format instead of falling back to the 30-minute default', () => {
    const tracker = AgentQuotaTracker.getInstance();
    const output =
      'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 59h30m58s.';

    const detected = tracker.recordFailure('agy', output);
    expect(detected).toBe(true);

    const status = tracker.getQuotaStatus('agy');
    expect(status.status).toBe('quota_exhausted');
    expect(status.reason).toContain('resets in 59h30m58s');
    expect(status.resetAt).toBeInstanceOf(Date);

    const expectedMs = (59 * 60 * 60 + 30 * 60 + 58) * 1000;
    const actualMs = status.resetAt!.getTime() - Date.now();
    // Allow a small tolerance for test execution time.
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5000);

    expect(tracker.isAvailable('agy')).toBe(false);
  });

  it('replays historical quota output using the original observation time', () => {
    const tracker = AgentQuotaTracker.getInstance();
    const observedAt = Date.now() - 60_000;

    tracker.recordFailure(
      'agy',
      'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h0m0s.',
      observedAt,
    );

    const status = tracker.getQuotaStatus('agy');
    expect(status.status).toBe('quota_exhausted');
    expect(status.resetAt).toBeInstanceOf(Date);
    expect(Math.abs(status.resetAt!.getTime() - (observedAt + 2 * 60 * 60 * 1000))).toBeLessThan(
      1000,
    );
  });

  it('hydrates quota state from durable storage across process-like singleton resets', () => {
    const records = new Map<string, any>();
    const store = {
      list: () => Array.from(records.values()),
      upsert: (record: any) => records.set(record.agentId, { ...record }),
      delete: (agentId: string) => records.delete(agentId),
    };

    const first = AgentQuotaTracker.getInstance();
    first.configureStore(store);
    first.recordFailure(
      'agy',
      'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 34h23m41s.',
    );

    expect(records.get('agy')?.status).toBe('quota_exhausted');
    const originalResetAt = records.get('agy')?.resetAt;
    expect(originalResetAt).toBeGreaterThan(Date.now());

    AgentQuotaTracker.resetInstance();
    const restarted = AgentQuotaTracker.getInstance();
    restarted.configureStore(store);

    const status = restarted.getQuotaStatus('agy');
    expect(status.status).toBe('quota_exhausted');
    expect(status.resetAt?.getTime()).toBe(originalResetAt);
    expect(restarted.isAvailable('agy')).toBe(false);
  });

  it('removes expired durable cooldowns so the next execution can probe recovery', () => {
    const records = new Map<string, any>([
      [
        'agy',
        {
          agentId: 'agy',
          status: 'quota_exhausted',
          reason: 'old quota',
          recordedAt: Date.now() - 10_000,
          resetAt: Date.now() - 100,
          source: 'runtime',
        },
      ],
    ]);
    const store = {
      list: () => Array.from(records.values()),
      upsert: (record: any) => records.set(record.agentId, { ...record }),
      delete: (agentId: string) => records.delete(agentId),
    };

    const tracker = AgentQuotaTracker.getInstance();
    tracker.configureStore(store);

    expect(tracker.isAvailable('agy')).toBe(true);
    expect(records.has('agy')).toBe(false);
  });

  it('AgentDetector reports ready after resetAt has elapsed without restarting TaskForge', async () => {
    const tracker = AgentQuotaTracker.getInstance();
    const observedAt = Date.now() - 2 * 60 * 60 * 1000;

    tracker.recordFailure(
      'agy',
      'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h0m0s.',
      observedAt,
    );

    const fakeAgy = new FakeAgent('agy', 'Google Antigravity');
    const reports = await AgentDetector.detect([fakeAgy]);

    expect(reports[0].ready).toBe(true);
    expect(reports[0].quotaStatus).toBe('ready');
    expect(reports[0].resetAt).toBeUndefined();
  });

  it('clears quota exhaustion on recordSuccess', () => {
    const tracker = AgentQuotaTracker.getInstance();
    tracker.setManualStatus('agy', 'quota_exhausted', 'limit hit');
    expect(tracker.isAvailable('agy')).toBe(false);

    tracker.recordSuccess('agy');
    expect(tracker.isAvailable('agy')).toBe(true);
    expect(tracker.getQuotaStatus('agy').status).toBe('ready');
  });

  it('AgentDetector marks agent ready=false when quota is exhausted', async () => {
    const tracker = AgentQuotaTracker.getInstance();
    tracker.setManualStatus('codex', 'quota_exhausted', 'cooldown until 1:42 PM');

    const fakeCodex = new FakeAgent('codex', 'Codex CLI');
    const fakeClaude = new FakeAgent('claude', 'Claude Code');

    const reports = await AgentDetector.detect([fakeCodex, fakeClaude]);

    const codexReport = reports.find((r) => r.id === 'codex');
    expect(codexReport).toBeDefined();
    expect(codexReport?.ready).toBe(false);
    expect(codexReport?.quotaStatus).toBe('quota_exhausted');
    expect(codexReport?.quotaReason).toBe('cooldown until 1:42 PM');

    const claudeReport = reports.find((r) => r.id === 'claude');
    expect(claudeReport).toBeDefined();
    expect(claudeReport?.ready).toBe(true);
    expect(claudeReport?.quotaStatus).toBe('ready');
  });
});
