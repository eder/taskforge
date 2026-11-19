import { describe, it, expect, vi } from 'vitest';
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

  it('uses the configured gateway for health and routing with a dedicated bearer key', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({ url, authorization: headers.get('Authorization') });
      if (url.endsWith('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('gateway unavailable', { status: 503 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new OpenAIRoutingProvider('freellmapi-unit-test', 'auto', 1000, {
        baseUrl: 'http://localhost:3001/v1/',
      });
      expect((await provider.healthCheck({ validateKey: true })).status).toBe('healthy');
      await provider.route({
        task: {
          id: 'TASK-01',
          goalId: 'test',
          title: 'Fix authentication',
          description: 'Implement auth',
          type: 'implementation',
          status: 'proposed',
          dependencies: [],
          contract: {
            objective: 'Implement auth',
            allowedScope: ['src/**'],
            forbiddenChanges: [],
            acceptanceCriteria: ['Auth tests pass'],
            dependencies: [],
          },
          acceptanceCriteria: ['Auth tests pass'],
          reworkCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        availableAgents: ['codex'],
      });
      expect(seen.map((r) => r.url)).toEqual([
        'http://localhost:3001/v1/models',
        'http://localhost:3001/v1/chat/completions',
      ]);
      expect(seen.every((r) => r.authorization === 'Bearer freellmapi-unit-test')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
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
