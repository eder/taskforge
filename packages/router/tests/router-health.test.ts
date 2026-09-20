import { describe, it, expect } from 'vitest';
import {
  StaticRoutingProvider,
  AdaptiveRoutingProvider,
  OpenAIRoutingProvider,
} from '../src/index.js';
import { PerformanceEngine } from '@taskforge/telemetry';
import { TaskForgeDatabase } from '@taskforge/persistence';

describe('Router Health Checks', () => {
  it('StaticRoutingProvider reports healthy status', async () => {
    const staticRouter = new StaticRoutingProvider();
    const health = await staticRouter.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.provider).toBe('static');
    expect(health.adaptive).toBe(false);
    expect(health.details).toContain('Deterministic rule-based');
  });

  it('AdaptiveRoutingProvider reports healthy when performance engine attached', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const perfEngine = new PerformanceEngine(db);
    const adaptiveRouter = new AdaptiveRoutingProvider(perfEngine);

    const health = await adaptiveRouter.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.provider).toBe('adaptive');
    expect(health.adaptive).toBe(true);
    expect(health.details).toContain('Adaptive engine active');
  });

  it('AdaptiveRoutingProvider reports degraded when performance engine is missing', async () => {
    const adaptiveRouter = new AdaptiveRoutingProvider(undefined as any);
    const health = await adaptiveRouter.healthCheck();
    expect(health.status).toBe('degraded');
    expect(health.provider).toBe('adaptive');
  });

  it('OpenAIRoutingProvider reports healthy when API key is present', async () => {
    const openaiRouter = new OpenAIRoutingProvider('sk-test-key-12345', 'gpt-5.6-luna');
    const health = await openaiRouter.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.provider).toBe('openai');
    expect(health.model).toBe('gpt-5.6-luna');
  });

  it('OpenAIRoutingProvider reports degraded when API key is missing', async () => {
    const openaiRouter = new OpenAIRoutingProvider('', 'gpt-5.6-luna');
    const health = await openaiRouter.healthCheck();
    expect(health.status).toBe('degraded');
    expect(health.provider).toBe('openai');
    expect(health.details).toContain('missing API key');
  });
});
