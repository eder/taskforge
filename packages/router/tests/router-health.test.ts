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
    expect(health.details).toContain('Adaptive structure active');
    expect(health.details).toContain('deterministic task-agent fit');
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

  it('OpenAIRoutingProvider constructor respects TASKFORGE_OPENAI_API_KEY over OPENAI_API_KEY', () => {
    const origTaskforge = process.env.TASKFORGE_OPENAI_API_KEY;
    const origOpenai = process.env.OPENAI_API_KEY;

    try {
      process.env.TASKFORGE_OPENAI_API_KEY = 'sk-taskforge-dedicated';
      process.env.OPENAI_API_KEY = 'sk-openai-global';

      const router = new OpenAIRoutingProvider(undefined, 'gpt-4o');
      expect((router as any).apiKey).toBe('sk-taskforge-dedicated');
    } finally {
      if (origTaskforge !== undefined) process.env.TASKFORGE_OPENAI_API_KEY = origTaskforge;
      else delete process.env.TASKFORGE_OPENAI_API_KEY;

      if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it('OpenAIRoutingProvider reports degraded when validateKey is true and endpoint returns 401', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), {
          status: 401,
          statusText: 'Unauthorized',
        });

      const openaiRouter = new OpenAIRoutingProvider('sk-invalid-key', 'gpt-4o');
      const health = await openaiRouter.healthCheck({ validateKey: true });

      expect(health.status).toBe('degraded');
      expect(health.details).toContain('invalid API key');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
