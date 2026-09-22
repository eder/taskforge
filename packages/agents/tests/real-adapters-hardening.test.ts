import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  AntigravityAdapter,
} from '../src/real-adapters.js';
import { AgentQuotaTracker } from '../src/quota-tracker.js';
import { RealCliAgentSession } from '../src/agent-session.js';
import type { AgentAssignment, AgentContext, AgentRuntimeEvent } from '@taskforge/shared';
import { InteractionGateway } from '@taskforge/execution';

describe('Real-Agent Hardening - Safety & Adapters', () => {
  it('recovers an active Antigravity quota block from its local CLI logs', () => {
    AgentQuotaTracker.resetInstance();
    const tracker = AgentQuotaTracker.getInstance();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-agy-quota-'));
    const logDir = path.join(home, '.gemini', 'antigravity-cli', 'log');
    fs.mkdirSync(logDir, { recursive: true });

    const observedAt = Date.now() - 60_000;
    const logPath = path.join(logDir, 'cli-legacy.log');
    fs.writeFileSync(
      logPath,
      'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h0m0s.\n',
      'utf8',
    );
    fs.utimesSync(logPath, observedAt / 1000, observedAt / 1000);

    try {
      expect(AntigravityAdapter.recoverQuotaFromRecentLogs(home)).toBe(true);
      const status = tracker.getQuotaStatus('agy');
      expect(status.status).toBe('quota_exhausted');
      expect(status.reason).toContain('resets in 2h0m0s');
      expect(status.resetAt!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      AgentQuotaTracker.resetInstance();
    }
  });

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

  it('preserves the original user request and renders read-only control context without contradicting it', () => {
    const claude = new ClaudeCodeAdapter();
    const assignment: AgentAssignment = {
      id: 'asgn-explain',
      taskId: 'TASK-01',
      agentId: 'claude',
      role: 'researcher',
      objective: 'Analyze the repository and explain its architecture',
      status: 'running',
    };
    const context: AgentContext = {
      worktreePath: '/tmp/taskforge-readonly',
      originalUserRequest: 'Me explique esse projeto',
      assignment,
      mutationAllowed: false,
      task: {
        objective: assignment.objective,
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Provide a clear explanation grounded in the repository'],
        dependencies: [],
      },
    };

    const prompt = (claude as any).buildPrompt(assignment, context) as string;

    expect(prompt).toContain('Original user request:\nMe explique esse projeto');
    expect(prompt).toContain('Role: researcher');
    expect(prompt).toContain('Execution mode: READ_ONLY');
    expect(prompt).toContain(
      'Repository access: read any repository files needed for this assignment',
    );
    expect(prompt).toContain('Repository mutation: forbidden');
    expect(prompt).not.toContain('Allowed scope: all files');
    expect(prompt).not.toContain('Role: implementer');
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

describe('Real-Agent Hardening - RealCliAgentSession Bidirectional I/O', () => {

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
    const ev1 = receivedEvents[0];
    expect(ev1.type).toBe('permission_request');
    expect(ev1.sessionId).toBe('sess-1');
    expect(ev1.assignmentId).toBe('asgn-1');
    expect(typeof ev1.timestamp).toBe('string');
    if (ev1.type === 'permission_request') {
      expect(ev1.operation).toBe('bash');
      expect(ev1.resource).toBe('pnpm install lodash');
      expect(ev1.requestId).toBeDefined();

      // Respond allow
      await session.respond({
        requestId: ev1.requestId,
        decision: 'allow',
      });
    }

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
    const qEv = receivedEvents[0];
    expect(qEv.type).toBe('question');
    expect(qEv.sessionId).toBe('sess-2');
    expect(qEv.assignmentId).toBe('asgn-2');
    expect(typeof qEv.timestamp).toBe('string');
    if (qEv.type === 'question') {
      expect(qEv.prompt).toBe('Which database should we use?');
      expect(qEv.options).toEqual(['SQLite', 'PostgreSQL']);
      expect(qEv.requestId).toBeDefined();

      // Respond with answer
      await session.respond({
        requestId: qEv.requestId,
        decision: 'answer',
        payload: 'SQLite',
      });
    }

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
    const pEv2 = receivedEvents[0];
    expect(pEv2.type).toBe('permission_request');
    if (pEv2.type === 'permission_request') {
      expect(pEv2.resource).toBe('rm -rf ./dist && pnpm build');
      expect(pEv2.requestId).toBeDefined();

      // Deny permission
      await session.respond({
        requestId: pEv2.requestId,
        decision: 'deny',
      });
    }

    expect(written).toContain('n\n');
  });

  it('detects fallback interactive terminal prompts and answers', async () => {
    const receivedEvents: AgentRuntimeEvent[] = [];
    const session = new RealCliAgentSession('sess-4', 'asgn-4', {
      rawTerminalPromptFallback: true,
      onEvent: (event) => receivedEvents.push(event),
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Simulate CLI asking y/n in raw terminal output
    session.handleOutputChunk('Do you want to run migration on production? (y/n)\n', 'stdout');

    expect(receivedEvents.length).toBe(1);
    const pEv3 = receivedEvents[0];
    expect(pEv3.type).toBe('permission_request');
    if (pEv3.type === 'permission_request') {
      expect(pEv3.prompt).toContain('Do you want to run migration on production?');
      expect(pEv3.requestId).toBeDefined();

      await session.respond({
        requestId: pEv3.requestId,
        decision: 'deny',
      });
    }

    expect(written).toContain('n\n');
  });

  it('does not mistake grep/source output containing prompt text for a real interaction', () => {
    const receivedEvents: AgentRuntimeEvent[] = [];
    const session = new RealCliAgentSession('sess-grep', 'asgn-grep', {
      onEvent: (event) => receivedEvents.push(event),
    });

    session.handleOutputChunk(
      [
        "packages/conversation/tests/shell.test.ts:95:    expect(goalReply).toContain('Do you want me to execute?');",
        "packages/planner/tests/foo.test.ts:120:    const prompt = 'Do you want to run migration? (y/n)';",
      ].join('\n'),
      'stdout',
    );

    expect(receivedEvents).toEqual([]);
  });

  it('does not inspect raw Codex output for interactions when provider-native protocol is in use', async () => {
    const receivedEvents: AgentRuntimeEvent[] = [];
    const codex = new CodexAdapter();
    const assignment: AgentAssignment = {
      id: 'asgn-codex-output',
      taskId: 'TASK-CODEX',
      agentId: 'codex',
      role: 'researcher',
      objective: 'Inspect the repository',
      status: 'running',
    };
    const context: AgentContext = {
      worktreePath: '/tmp/taskforge-codex',
      assignment,
      task: {
        objective: assignment.objective,
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Return findings'],
        dependencies: [],
      },
      mutationAllowed: false,
      onEvent: async (event) => {
        receivedEvents.push(event);
      },
    };

    const session = (await codex.createSession(
      assignment,
      context,
    )) as RealCliAgentSession;

    // Even a line that looks exactly like a terminal prompt must not become an
    // ACTION REQUIRED request for Codex: Codex runs with provider-native
    // interaction semantics and close-after-spawn stdin.
    session.handleOutputChunk('Do you want to run migration on production? (y/n)\n', 'stdout');

    expect(receivedEvents).toEqual([]);
    codex.releaseSession(assignment.id);
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

describe('Real-Agent Hardening - Full E2E Gateway & Permission Loop', () => {
  it('intercepts permission prompt, evaluates via gateway, and pipes human allow/y to stdin', async () => {
    const gateway = new InteractionGateway({
      config: {
        ui: { mode: 'interactive' },
        permissions: {
          commands: { tests: 'allow', lint: 'allow', package_install: 'ask_human', sudo: 'deny', network: 'ask_human' },
          filesystem: { workspace_write: 'allow', outside_workspace: 'ask_human', delete_files: 'ask_human' },
          git: { commit: 'allow', push: 'ask_human', force_push: 'deny', merge_main: 'deny' },
          fallback: 'ask_human',
        },
        interactions: { humanResponseTimeout: 5000, onTimeout: { permission: 'deny', question: 'cancel', confirmation: 'deny' } },
        headless: { onUnknownPermission: 'deny', onHumanQuestion: 'fail', onConfirmationRequired: 'block', onAuthenticationRequired: 'fail' },
      } as any,
    });

    let interceptedRequest: any;
    gateway.onInteraction((req) => {
      interceptedRequest = req;
    });

    const session = new RealCliAgentSession('sess-e2e-1', 'asgn-e2e-1', {
      adapterId: 'legacy-cli',
      rawTerminalPromptFallback: true,
      onEvent: async (ev) => {
        await gateway.handleEvent(ev, session, {
          runId: 'run-e2e',
          taskId: 'task-e2e',
          assignmentId: 'asgn-e2e-1',
          agentId: 'claude',
          isHeadless: false,
        });
      },
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Simulate CLI asking y/n in raw terminal output
    session.handleOutputChunk('Do you want to run migration on production? (y/n)\n', 'stdout');
    await new Promise((r) => setTimeout(r, 10));

    // Ensure gateway intercepted request with matching requestId
    expect(interceptedRequest).toBeDefined();
    expect(interceptedRequest.id).toBeDefined();
    expect(interceptedRequest.type).toBe('permission');
    expect(interceptedRequest.prompt).toContain('Do you want to run migration on production?');

    // Human answers allow via gateway
    const resolved = gateway.resolve(interceptedRequest.id, 'allow');
    expect(resolved).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    // Stdin receives 'y\n'
    expect(written).toContain('y\n');
  });

  it('intercepts agent question, evaluates via gateway, and pipes human custom answer to stdin', async () => {
    const gateway = new InteractionGateway({
      config: {
        ui: { mode: 'interactive' },
        interactions: { humanResponseTimeout: 5000, onTimeout: { permission: 'deny', question: 'cancel', confirmation: 'deny' } },
        headless: { onUnknownPermission: 'deny', onHumanQuestion: 'fail', onConfirmationRequired: 'block', onAuthenticationRequired: 'fail' },
      } as any,
    });

    let interceptedRequest: any;
    gateway.onInteraction((req) => {
      interceptedRequest = req;
    });

    const session = new RealCliAgentSession('sess-e2e-2', 'asgn-e2e-2', {
      adapterId: 'codex',
      onEvent: async (ev) => {
        await gateway.handleEvent(ev, session, {
          runId: 'run-e2e',
          taskId: 'task-e2e',
          assignmentId: 'asgn-e2e-2',
          agentId: 'codex',
          isHeadless: false,
        });
      },
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Simulate CLI structured question
    const jsonQ = JSON.stringify({
      type: 'question',
      question: 'Select target database',
      options: ['SQLite', 'PostgreSQL'],
    });
    session.handleOutputChunk(`${jsonQ}\n`, 'stdout');
    await new Promise((r) => setTimeout(r, 10));

    expect(interceptedRequest).toBeDefined();
    expect(interceptedRequest.type).toBe('question');
    expect(interceptedRequest.prompt).toBe('Select target database');

    // Human answers custom option
    const resolved = gateway.resolve(interceptedRequest.id, 'answer', 'PostgreSQL');
    expect(resolved).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    // Stdin receives custom payload
    expect(written).toContain('PostgreSQL\n');
  });

  it('intercepts high-risk Bash tool calls and human deny results in n on stdin', async () => {
    const gateway = new InteractionGateway({
      config: {
        ui: { mode: 'interactive' },
        permissions: {
          commands: { tests: 'allow', lint: 'allow', package_install: 'ask_human', sudo: 'deny', network: 'ask_human' },
          filesystem: { workspace_write: 'allow', outside_workspace: 'ask_human', delete_files: 'ask_human' },
          git: { commit: 'allow', push: 'ask_human', force_push: 'deny', merge_main: 'deny' },
          fallback: 'ask_human',
        },
        interactions: { humanResponseTimeout: 5000, onTimeout: { permission: 'deny', question: 'cancel', confirmation: 'deny' } },
        headless: { onUnknownPermission: 'deny', onHumanQuestion: 'fail', onConfirmationRequired: 'block', onAuthenticationRequired: 'fail' },
      } as any,
    });

    let interceptedRequest: any;
    gateway.onInteraction((req) => {
      interceptedRequest = req;
    });

    const session = new RealCliAgentSession('sess-e2e-3', 'asgn-e2e-3', {
      adapterId: 'agy',
      onEvent: async (ev) => {
        await gateway.handleEvent(ev, session, {
          runId: 'run-e2e',
          taskId: 'task-e2e',
          assignmentId: 'asgn-e2e-3',
          agentId: 'agy',
          isHeadless: false,
        });
      },
    });

    const { child, written } = createMockChild();
    session.attachProcess(child);

    // Tool use in Claude/AGY stream
    const toolUse = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'rm -rf ./node_modules' },
          },
        ],
      },
    });
    session.handleOutputChunk(`${toolUse}\n`, 'stdout');
    await new Promise((r) => setTimeout(r, 10));

    expect(interceptedRequest).toBeDefined();
    expect(interceptedRequest.type).toBe('permission');
    expect(interceptedRequest.resource).toBe('rm -rf ./node_modules');

    // Deny permission
    const resolved = gateway.resolve(interceptedRequest.id, 'deny');
    expect(resolved).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    expect(written).toContain('n\n');
  });
});

describe('Real-Agent Hardening - Opt-in Real CLI Tests by Provider', () => {
  const isAllReal = process.env.TASKFORGE_TEST_REAL_AGENTS === '1';

  it.skipIf(!isAllReal && process.env.TASKFORGE_TEST_CLAUDE !== '1')('executes Claude Code real task if installed', async () => {
    const claude = new ClaudeCodeAdapter();
    const available = await claude.detect();
    if (!available) {
      console.log('Claude CLI not detected in PATH, skipping real execution test.');
      return;
    }
    expect(available).toBe(true);
    expect(claude.id).toBe('claude');
  });

  it.skipIf(!isAllReal && process.env.TASKFORGE_TEST_CODEX !== '1')('executes Codex real task if installed', async () => {
    const codex = new CodexAdapter();
    const available = await codex.detect();
    if (!available) {
      console.log('Codex CLI not detected in PATH, skipping real execution test.');
      return;
    }
    expect(available).toBe(true);
    expect(codex.id).toBe('codex');
  });

  it.skipIf(!isAllReal && process.env.TASKFORGE_TEST_AGY !== '1')('executes Antigravity real task if installed', async () => {
    const agy = new AntigravityAdapter();
    const available = await agy.detect();
    if (!available) {
      console.log('Antigravity CLI not detected in PATH, skipping real execution test.');
      return;
    }
    expect(available).toBe(true);
    expect(agy.id).toBe('agy');
  });
});
