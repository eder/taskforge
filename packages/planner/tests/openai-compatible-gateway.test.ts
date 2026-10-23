import { describe, it, expect, vi } from 'vitest';
import { SemanticPlanner } from '../src/semantic-planner.js';

describe('SemanticPlanner OpenAI-compatible gateway', () => {
  it('sends intent decisions to the selected endpoint instead of api.openai.com', async () => {
    const calls: Array<{ url: string; auth: string | null; model: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
        const headers = new Headers(options.headers);
        const payload = JSON.parse(String(options.body)) as { model: string };
        calls.push({ url, auth: headers.get('Authorization'), model: payload.model });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ readOnly: true, forbiddenTargets: [] }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    try {
      const planner = new SemanticPlanner({
        apiKey: 'freellmapi-test-key',
        baseUrl: 'http://localhost:3001/v1/',
        model: 'auto',
      });
      expect(await planner.judgeExecutionIntent('Analise sem modificar arquivos')).toEqual({
        readOnly: true,
        forbiddenTargets: [],
      });
      expect(calls).toEqual([
        {
          url: 'http://localhost:3001/v1/chat/completions',
          auth: 'Bearer freellmapi-test-key',
          model: 'auto',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not take a global OpenAI credential for an explicitly configured gateway', () => {
    const originalDedicated = process.env.TASKFORGE_OPENAI_API_KEY;
    const originalGlobal = process.env.OPENAI_API_KEY;
    try {
      delete process.env.TASKFORGE_OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-not-for-gateway';
      const planner = new SemanticPlanner({
        baseUrl: 'http://localhost:3001/v1',
        model: 'auto',
      });
      expect((planner as unknown as { apiKey?: string }).apiKey).toBeUndefined();
    } finally {
      if (originalDedicated === undefined) delete process.env.TASKFORGE_OPENAI_API_KEY;
      else process.env.TASKFORGE_OPENAI_API_KEY = originalDedicated;
      if (originalGlobal === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalGlobal;
    }
  });
});
