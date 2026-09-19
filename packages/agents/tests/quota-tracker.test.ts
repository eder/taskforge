import { describe, it, expect, beforeEach } from 'vitest';
import { AgentQuotaTracker } from '../src/quota-tracker.js';
import { AgentDetector, AgentRegistry } from '../src/agent-registry.js';
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
