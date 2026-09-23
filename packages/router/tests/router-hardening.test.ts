import { describe, it, expect, vi } from 'vitest';
import { Task } from '@taskforge/core';
import {
  OpenAIRoutingProvider,
  RouterQualityGuard,
} from '../src/index.js';

describe('Router Fallback Observability and Quality Guard', () => {
  const sampleTask: Task = {
    id: 'TASK-01',
    goalId: 'goal-1',
    title: 'Harden runtime concurrency and process lifecycle',
    description:
      'Improve concurrency slot management, fix child process lifecycle stdin/stdout, and clean worktrees across scheduler, agents and core packages.',
    type: 'implementation',
    status: 'proposed',
    dependencies: [],
    contract: {
      objective: 'Harden runtime concurrency, process lifecycle, worktrees and session routing',
      allowedScope: ['*'],
      forbiddenChanges: [],
      acceptanceCriteria: ['All tests pass'],
      dependencies: [],
    },
    acceptanceCriteria: ['All tests pass'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('Requirement 24.E: router timeout visibly records static fallback with timeout reason', async () => {
    // Mock global fetch to simulate a timeout / AbortError
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    try {
      const provider = new OpenAIRoutingProvider('fake-api-key', 'gpt-5.6-luna', 50);
      const decision = await provider.route({
        task: sampleTask,
        availableAgents: ['claude', 'codex', 'agy'],
      });

      expect(decision.source).toBe('fallback');
      expect(decision.provider).toBe('openai');
      expect(decision.model).toBe('gpt-5.6-luna');
      expect(decision.fallbackReason).toBe('timeout');
      expect(decision.reason).toContain('[Fallback from OpenAI/gpt-5.6-luna (timeout)]');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('records the HTTP status when routing falls back after a provider error', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    try {
      const provider = new OpenAIRoutingProvider('fake-api-key', 'gpt-5.6-luna');
      const decision = await provider.route({
        task: sampleTask,
        availableAgents: ['claude', 'codex'],
      });

      expect(decision.source).toBe('fallback');
      expect(decision.fallbackReason).toBe('http_error');
      expect(decision.fallbackDetail).toBe('HTTP 401');
      expect(decision.reason).toContain('HTTP 401');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('records provider_unavailable when API key is missing', async () => {
    const provider = new OpenAIRoutingProvider('', 'gpt-5.6-luna');
    const decision = await provider.route({
      task: sampleTask,
      availableAgents: ['claude', 'codex'],
    });

    expect(decision.source).toBe('fallback');
    expect(decision.fallbackReason).toBe('provider_unavailable');
  });

  it('Requirement 8: RouterQualityGuard upgrades low complexity and risk when complex runtime signals are present', () => {
    const rawProposal = {
      strategy: 'single' as const,
      complexity: 'low' as const,
      risk: 'low' as const,
      uncertainty: 'low' as const,
      teamSize: 1,
      roles: [
        {
          role: 'implementer' as const,
          requiredCapabilities: ['canWrite'],
          objective: 'Do it',
        },
      ],
      communication: {
        required: false,
        initialAlignment: false,
        synthesisBeforeImplementation: false,
      },
      reason: 'Simple task',
      source: 'openai' as const,
    };

    const guarded = RouterQualityGuard.evaluate(rawProposal, {
      task: sampleTask,
      availableAgents: ['claude', 'codex'],
    });

    expect(guarded.complexity).toBe('high');
    expect(guarded.risk).toBe('high');
    expect(guarded.routerProposal).toBeDefined();
    expect(guarded.routerProposal!.complexity).toBe('low');
    expect(guarded.routerProposal!.risk).toBe('low');
    expect(guarded.policyAdjustment).toBeDefined();
    expect(guarded.policyAdjustment!.originalComplexity).toBe('low');
    expect(guarded.policyAdjustment!.adjustedComplexity).toBe('high');
    expect(guarded.policyAdjustment!.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
