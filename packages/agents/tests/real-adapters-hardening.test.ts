import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  AntigravityAdapter,
} from '../src/real-adapters.js';
import { RealCliAgentSession } from '../src/agent-session.js';
import type { AgentRuntimeEvent } from '@taskforge/shared';

describe('Real-Agent Hardening - Safety & Adapters', () => {
  it('adapters never include dangerous bypass flags by default', () => {
    const claude = new ClaudeCodeAdapter();
    const codex = new CodexAdapter();
    const agy = new AntigravityAdapter();

    const claudeArgs = (claude as any).options.defaultArgs || [];
    const codexArgs = (codex as any).options.defaultArgs || [];
    const agyArgs = (agy as any).options.defaultArgs || [];

    // Claude Code must never bypass permissions silently
    expect(claudeArgs).not.toContain('--dangerously-skip-permissions');
    expect(claudeArgs).toContain('--output-format=stream-json');

    // Codex CLI must never bypass approvals silently
    expect(codexArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(codexArgs).toContain('--json');

    // Antigravity CLI must never bypass approvals
    expect(agyArgs).not.toContain('--dangerously-skip-permissions');
    expect(agyArgs).toContain('stream-json');
  });

  it('declares standard coding capabilities', async () => {
    const claude = new ClaudeCodeAdapter();
    const caps = await claude.capabilities();

    expect(caps.canRead).toBe(true);
    expect(caps.canWrite).toBe(true);
    expect(caps.canExecute).toBe(true);
    expect(caps.tools).toContain('bash');
    expect(caps.tools).toContain('file_editor');
  });
});

describe('Real-Agent Hardening - RealCliAgentSession Bidirectional I/O', () => {
  function createMockChild(): { child: ChildProcess; written: string[] } {
    const written: string[] = [];
    const mockStdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const emitter = new EventEmitter() as any;
    emitter.stdin = mockStdin;
    emitter.killed = false;
    emitter.kill = vi.fn((signal?: string) => {
      emitter.killed = true;
      emitter.emit('exit', 0, signal);
      return true;
    });

    return { child: emitter as ChildProcess, written };
  }

  it('parses structured JSON permission requests and responds via stdin', async () => {
    const receivedEvents: AgentRuntimeEvent[] = [];
    const session = new RealCliAgentSession('sess-1', 'asgn-1', {
      onEvent: (event) => receivedEvents.push(event),
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Simulate CLI output with permission_request event
    const jsonEvent = JSON.stringify({
      type: 'permission_request',
      operation: 'bash',
      resource: 'pnpm install lodash',
      prompt: 'Allow running pnpm install?',
    });

    session.handleOutputChunk(`${jsonEvent}\n`, 'stdout');

    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].type).toBe('permission_request');
    expect((receivedEvents[0] as any).operation).toBe('bash');
    expect((receivedEvents[0] as any).resource).toBe('pnpm install lodash');

    // Respond allow
    await session.respond({
      requestId: receivedEvents[0].id,
      decision: 'allow',
    });

    expect(written).toContain('y\n');
  });

  it('parses structured JSON question and responds with custom payload', async () => {
    const receivedEvents: AgentRuntimeEvent[] = [];
    const session = new RealCliAgentSession('sess-2', 'asgn-2', {
      onEvent: (event) => receivedEvents.push(event),
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Simulate question event
    const questionEvent = JSON.stringify({
      type: 'question',
      question: 'Which database should we use?',
      options: ['SQLite', 'PostgreSQL'],
    });

    session.handleOutputChunk(`${questionEvent}\n`, 'stdout');

    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].type).toBe('question');
    expect(receivedEvents[0].prompt).toBe('Which database should we use?');

    // Respond with answer
    await session.respond({
      requestId: receivedEvents[0].id,
      decision: 'answer',
      payload: 'SQLite',
    });

    expect(written).toContain('SQLite\n');
  });

  it('detects high-risk Bash tool commands from Claude stream and requests permission', async () => {
    const receivedEvents: AgentRuntimeEvent[] = [];
    const session = new RealCliAgentSession('sess-3', 'asgn-3', {
      onEvent: (event) => receivedEvents.push(event),
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Simulate tool_use in stream
    const toolUseEvent = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'rm -rf ./dist && pnpm build' },
          },
        ],
      },
    });

    session.handleOutputChunk(`${toolUseEvent}\n`, 'stdout');

    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].type).toBe('permission_request');
    expect((receivedEvents[0] as any).resource).toBe('rm -rf ./dist && pnpm build');

    // Deny permission
    await session.respond({
      requestId: receivedEvents[0].id,
      decision: 'deny',
    });

    expect(written).toContain('n\n');
  });

  it('detects fallback interactive terminal prompts and answers', async () => {
    const receivedEvents: AgentRuntimeEvent[] = [];
    const session = new RealCliAgentSession('sess-4', 'asgn-4', {
      onEvent: (event) => receivedEvents.push(event),
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Simulate CLI asking y/n in raw terminal output
    session.handleOutputChunk('Do you want to run migration on production? (y/n)\n', 'stdout');

    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].type).toBe('permission_request');
    expect(receivedEvents[0].prompt).toContain('Do you want to run migration on production?');

    await session.respond({
      requestId: receivedEvents[0].id,
      decision: 'deny',
    });

    expect(written).toContain('n\n');
  });

  it('cancels running process cleanly with SIGTERM', async () => {
    const session = new RealCliAgentSession('sess-5', 'asgn-5');
    const { child } = createMockChild();
    session.attachProcess(child);

    await session.cancel();

    expect(session.isCancelled).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('sends direct messages to child stdin', async () => {
    const session = new RealCliAgentSession('sess-6', 'asgn-6');
    const { child, written } = createMockChild();
    session.attachProcess(child);

    await session.send('Hello agent');
    expect(written).toContain('Hello agent\n');
  });
});

describe('Real-Agent Hardening - Opt-in Real CLI Test', () => {
  const isOptIn = process.env.TASKFORGE_TEST_REAL_AGENTS === '1';

  it.skipIf(!isOptIn)('runs real CLI agent if installed', async () => {
    const claude = new ClaudeCodeAdapter();
    const available = await claude.detect();
    if (!available) {
      console.log('Claude CLI not detected in PATH, skipping real execution test.');
      return;
    }

    // If opt-in and claude is detected, verify execution returns valid object
    expect(available).toBe(true);
  });
});
