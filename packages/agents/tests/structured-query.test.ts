import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentQuotaTracker,
  AgentRegistry,
  ClaudeCodeAdapter,
  CodexAdapter,
  createAgentModelCaller,
  parseClaudeStructuredOutput,
  parseCodexStructuredOutput,
  type AgentAdapter,
} from '../src/index.js';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

describe('structured output parsers', () => {
  it('reads a real `codex exec --json` run: the answer and the tokens', () => {
    const stdout = [
      'Reading additional input from stdin...',
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{\\"ok\\":true}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":15368,"cached_input_tokens":0,"output_tokens":15}}',
    ].join('\n');
    expect(parseCodexStructuredOutput(stdout)).toEqual({ value: { ok: true }, tokens: 15383 });
  });

  it('fails clearly when Codex returns no answer or reports an error', () => {
    expect(() => parseCodexStructuredOutput('{"type":"turn.started"}')).toThrow(/no final message/);
    expect(() => parseCodexStructuredOutput('{"type":"error","message":"quota"}')).toThrow(/quota/);
  });

  it('reads Claude output from structured_output or from result, and surfaces errors', () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 20,
      output_tokens: 3,
    };
    expect(
      parseClaudeStructuredOutput(JSON.stringify({ structured_output: { a: 1 }, usage })),
    ).toEqual({ value: { a: 1 }, tokens: 38 });
    expect(parseClaudeStructuredOutput(JSON.stringify({ result: '{"a":2}', usage })).value).toEqual(
      { a: 2 },
    );
    expect(() =>
      parseClaudeStructuredOutput(
        JSON.stringify({ is_error: true, result: 'Failed to authenticate' }),
      ),
    ).toThrow(/authenticate/);
  });
});

describe('structuredQuery through the real process path', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-sq-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function fakeBinary(name: string, script: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  }

  it('runs the CLI read-only with the schema and returns the answer', async () => {
    const argsFile = path.join(dir, 'args.txt');
    const bin = fakeBinary(
      'codex',
      `printf '%s\\n' "$@" > '${argsFile}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'`,
    );
    const result = await new CodexAdapter({ binaryPath: bin }).structuredQuery({
      prompt: 'plan it',
      schema: SCHEMA,
      cwd: dir,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ value: { ok: true }, tokens: 12 });
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).toContain('read-only');
    expect(args).toContain('--output-schema');
    expect(args).toContain('plan it');
  });

  it('reports a failing CLI with its own message', async () => {
    const bin = fakeBinary('codex', "echo 'not signed in' >&2\nexit 1");
    await expect(
      new CodexAdapter({ binaryPath: bin }).structuredQuery({
        prompt: 'x',
        schema: SCHEMA,
        cwd: dir,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/not signed in/);
  });

  it('gives up when the CLI does not answer in time', async () => {
    const bin = fakeBinary('claude', 'sleep 5');
    await expect(
      new ClaudeCodeAdapter({ binaryPath: bin }).structuredQuery({
        prompt: 'x',
        schema: SCHEMA,
        cwd: dir,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/did not answer within/);
  });

  it("does not hand TaskForge's own OpenAI key to the agent", async () => {
    process.env.TASKFORGE_OPENAI_API_KEY = 'sk-should-not-leak';
    try {
      const envFile = path.join(dir, 'env.txt');
      const bin = fakeBinary(
        'codex',
        `env > '${envFile}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'`,
      );
      await new CodexAdapter({ binaryPath: bin }).structuredQuery({
        prompt: 'x',
        schema: SCHEMA,
        cwd: dir,
        timeoutMs: 10_000,
      });
      expect(fs.readFileSync(envFile, 'utf8')).not.toContain('sk-should-not-leak');
    } finally {
      delete process.env.TASKFORGE_OPENAI_API_KEY;
    }
  });
});

describe('createAgentModelCaller', () => {
  function agent(
    id: string,
    query?: AgentAdapter['structuredQuery'],
    installed = true,
  ): AgentAdapter {
    return {
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
      structuredQuery: query,
    };
  }
  const registryOf = (...agents: AgentAdapter[]) => {
    const registry = new AgentRegistry(false);
    for (const a of agents) registry.register(a);
    return registry;
  };
  const messages = [{ role: 'user', content: 'plan' }];

  afterEach(() => AgentQuotaTracker.resetInstance());

  it('prefers Codex, passes the repository and timeout, and reports the tokens', async () => {
    const codex = vi.fn().mockResolvedValue({ value: { from: 'codex' }, tokens: 7 });
    const claude = vi.fn().mockResolvedValue({ value: { from: 'claude' } });
    const onUsage = vi.fn();
    const call = createAgentModelCaller(
      registryOf(agent('claude', claude), agent('codex', codex)),
      {
        cwd: '/repo',
        timeoutMs: 1234,
        onUsage,
      },
    );

    expect(await call(messages, SCHEMA)).toEqual({ from: 'codex' });
    expect(codex).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', timeoutMs: 1234, schema: SCHEMA }),
    );
    expect(claude).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledWith({ agentId: 'codex', tokens: 7 });
  });

  it('skips agents that are not installed or cannot answer structured questions', async () => {
    const claude = vi.fn().mockResolvedValue({ value: { from: 'claude' } });
    const call = createAgentModelCaller(
      registryOf(agent('codex', vi.fn(), false), agent('agy'), agent('claude', claude)),
      { cwd: '/repo', timeoutMs: 1 },
    );
    expect(await call(messages, SCHEMA)).toEqual({ from: 'claude' });
  });

  it('says so when no agent can plan, and does not retry on another agent after a failure', async () => {
    await expect(
      createAgentModelCaller(registryOf(agent('agy')), { cwd: '/r', timeoutMs: 1 })(
        messages,
        SCHEMA,
      ),
    ).rejects.toThrow(/No installed agent/);

    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const other = vi.fn().mockResolvedValue({ value: {} });
    const call = createAgentModelCaller(
      registryOf(agent('codex', failing), agent('claude', other)),
      { cwd: '/r', timeoutMs: 1 },
    );
    await expect(call(messages, SCHEMA)).rejects.toThrow('boom');
    expect(other).not.toHaveBeenCalled();
  });
});
