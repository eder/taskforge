import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAssignment, AgentContext, AgentStreamEvent } from '@taskforge/shared';
import { OllamaAdapter } from '../src/ollama-adapter.js';

function startMockOllamaServer(
  handler: (reqPath: string, body: Record<string, unknown>, callNum: number) => { status?: number; json: unknown },
): Promise<{ url: string; close: () => Promise<void> }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls += 1;
      const out = handler(req.url ?? '/', body, calls);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('OllamaAdapter (Agentic Tool-Calling & Structured Coordinator)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  function createTempWorktree(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ollama-wt-'));
    fs.writeFileSync(path.join(dir, 'math.ts'), 'export const add = (a: number, b: number) => a - b;\n', 'utf8');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function makeContext(worktreePath: string, mutationAllowed: boolean, events: AgentStreamEvent[] = []): AgentContext {
    return {
      worktreePath,
      originalUserRequest: 'Fix add in math.ts',
      mutationAllowed,
      onStreamEvent: (ev) => events.push(ev),
    };
  }

  const baseAssignment: AgentAssignment = {
    id: 'assign-ollama-1',
    taskId: 'TASK-01',
    agentId: 'ollama',
    role: 'implementer',
    objective: 'Fix the add function in math.ts so it adds a + b.',
    status: 'running',
  };

  it('executes a full multi-turn tool-calling loop (list_files -> read_file -> edit_file) and emits stream events', async () => {
    const wt = createTempWorktree();
    const events: AgentStreamEvent[] = [];

    const mock = await startMockOllamaServer((reqPath, body) => {
      if (reqPath === '/api/tags') {
        return { json: { models: [{ name: 'qwen2.5-coder:7b' }] } };
      }
      const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      if (toolMsgs.length === 0) {
        return {
          json: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'read_file', arguments: { path: 'math.ts' } } }],
            },
            prompt_eval_count: 50,
            eval_count: 20,
          },
        };
      }
      if (toolMsgs.length === 1) {
        expect(toolMsgs[0].content).toContain('a - b');
        return {
          json: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'edit_file',
                    arguments: { path: 'math.ts', target: 'a - b', replacement: 'a + b' },
                  },
                },
              ],
            },
            prompt_eval_count: 70,
            eval_count: 25,
          },
        };
      }
      expect(toolMsgs[1].content).toContain('OK: updated math.ts');
      return {
        json: {
          message: { role: 'assistant', content: 'Fixed add() in math.ts to return a + b.' },
          prompt_eval_count: 80,
          eval_count: 15,
        },
      };
    });
    cleanups.push(mock.close);

    const adapter = new OllamaAdapter({ baseUrl: mock.url, model: 'qwen2.5-coder:7b' });
    expect(await adapter.detect()).toBe(true);
    const caps = await adapter.capabilities();
    expect(caps.canWrite).toBe(true);
    expect(caps.tools).toContain('edit_file');

    const res = await adapter.execute(baseAssignment, makeContext(wt, true, events));
    expect(res.success).toBe(true);
    expect(res.output).toContain('Fixed add()');
    expect(res.usage?.totalTokens).toBe(260);
    expect(fs.readFileSync(path.join(wt, 'math.ts'), 'utf8')).toContain('a + b');
    expect(events.map((e) => e.type)).toEqual(['file_read', 'file_edit', 'agent_message']);
  });

  it('enforces read-only mode and blocks path traversal outside the worktree', async () => {
    const wt = createTempWorktree();
    const seenToolResults: string[] = [];

    const mock = await startMockOllamaServer((_reqPath, body) => {
      const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      // In read-only mode, write_file and edit_file must NOT even be advertised in `tools`.
      const advertisedTools = ((body.tools as Array<{ function?: { name?: string } }>) ?? []).map(
        (t) => t.function?.name,
      );
      expect(advertisedTools).not.toContain('write_file');
      expect(advertisedTools).not.toContain('edit_file');

      if (toolMsgs.length === 0) {
        return {
          json: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'write_file', arguments: { path: 'hack.ts', content: 'x' } } },
                { function: { name: 'read_file', arguments: { path: '../../etc/passwd' } } },
              ],
            },
          },
        };
      }
      seenToolResults.push(...toolMsgs.map((m) => m.content));
      return {
        json: { message: { role: 'assistant', content: 'Completed safely in read-only mode.' } },
      };
    });
    cleanups.push(mock.close);

    const adapter = new OllamaAdapter({ baseUrl: mock.url });
    const res = await adapter.execute(baseAssignment, makeContext(wt, false));
    expect(res.success).toBe(true);
    expect(seenToolResults[0]).toContain('disabled in read-only mode');
    expect(seenToolResults[1]).toContain('escapes the allowed worktree boundary');
    expect(fs.existsSync(path.join(wt, 'hack.ts'))).toBe(false);
  });

  it('falls back gracefully to plain chat when the local model does not support native tool calls', async () => {
    const wt = createTempWorktree();
    let seenWithoutTools = false;

    const mock = await startMockOllamaServer((_reqPath, body) => {
      if (body.tools) {
        return {
          status: 400,
          json: { error: 'registry.ollama.ai/library/codellama:latest does not support tools' },
        };
      }
      seenWithoutTools = true;
      return {
        json: { message: { role: 'assistant', content: 'Plain-chat fallback answer.' } },
      };
    });
    cleanups.push(mock.close);

    const adapter = new OllamaAdapter({ baseUrl: mock.url, model: 'codellama:latest' });
    const res = await adapter.execute(baseAssignment, makeContext(wt, true));
    expect(res.success).toBe(true);
    expect(seenWithoutTools).toBe(true);
    expect(res.output).toContain('Plain-chat fallback answer');
  });

  it('answers structuredQuery() using Ollama native JSON schema format for local planning & arbitration', async () => {
    let receivedFormat: unknown;
    const mock = await startMockOllamaServer((_reqPath, body) => {
      receivedFormat = body.format;
      return {
        json: {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              winnerIndex: 2,
              reasoning: 'Antigravity handles edge cases cleanly with minimal diff.',
            }),
          },
          prompt_eval_count: 120,
          eval_count: 30,
        },
      };
    });
    cleanups.push(mock.close);

    const adapter = new OllamaAdapter({ baseUrl: mock.url, model: 'qwen2.5-coder:7b' });
    const schema = {
      type: 'object',
      properties: { winnerIndex: { type: 'integer' }, reasoning: { type: 'string' } },
      required: ['winnerIndex', 'reasoning'],
    };
    const sq = await adapter.structuredQuery({
      prompt: 'Compare candidate #1 and #2',
      schema,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(receivedFormat).toEqual(schema);
    expect(sq.value).toEqual({
      winnerIndex: 2,
      reasoning: 'Antigravity handles edge cases cleanly with minimal diff.',
    });
    expect(sq.tokens).toBe(150);
  });
});
