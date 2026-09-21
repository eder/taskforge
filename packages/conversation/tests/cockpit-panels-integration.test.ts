import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentActivityTracker } from '@taskforge/agents';
import { TaskForgeDatabase, InteractionRepository } from '@taskforge/persistence';
import { AgentStreamBus, InteractionRequest } from '@taskforge/shared';
import { InteractiveShell } from '../src/interactive-shell.js';

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('InteractiveShell cockpit panels', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;
  let outputText: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cockpit-panel-test-'));
    db = new TaskForgeDatabase(path.join(tmpDir, 'test.db'));
    outputText = '';
  });

  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // already closed by shell
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOutput(): Writable {
    return new Writable({
      write(chunk, _encoding, callback) {
        outputText += chunk.toString();
        callback();
      },
    });
  }

  it('writes the full ACTION REQUIRED panel to upper scrollback as soon as attention is requested', () => {
    const tracker = new AgentActivityTracker();
    shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      activityTracker: tracker,
      output: makeOutput(),
      interactive: false,
    });

    tracker.register({
      taskId: 'TASK-HITL',
      assignmentId: 'asgn-hitl',
      taskTitle: 'Install runtime dependency',
      agentId: 'codex',
      agentName: 'Codex CLI',
      role: 'implementer',
      status: 'Waiting',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });

    tracker.setAttention('asgn-hitl', {
      type: 'permission',
      requestId: 'req-hitl',
      category: 'commands',
      operation: 'install package',
      resource: 'pnpm add zod',
      prompt: 'A new package is required to complete the task.',
    });

    const output = stripAnsi(outputText);
    expect(output).toContain('ACTION REQUIRED');
    expect(output).toContain('Codex CLI');
    expect(output).toContain('TASK-HITL');
    expect(output).toContain('install package');
    expect(output).toContain('pnpm add zod');
    expect(output).toContain('A new package is required to complete the task.');
    expect(output).toContain('/approve req-hitl once');
    expect(output).toContain('/approve req-hitl task');
    expect(output).toContain('/deny req-hitl');
  });

  it('renders allowed and denied responses through the existing interaction commands', async () => {
    shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      output: makeOutput(),
      interactive: false,
    });

    const repo = new InteractionRepository(db);
    const base = {
      runId: 'run-hitl',
      taskId: 'TASK-HITL',
      assignmentId: 'asgn-hitl',
      agentId: 'claude',
      type: 'permission' as const,
      prompt: 'Run external command',
      category: 'commands',
      resource: 'pnpm test',
      status: 'pending' as const,
      priority: 'normal' as const,
      createdAt: new Date().toISOString(),
    };

    const allowRequest: InteractionRequest = { id: 'req-allow', ...base };
    repo.createRequest(allowRequest);
    const allowed = stripAnsi(await shell.handleInput('/approve req-allow once'));
    expect(allowed).toContain('ACTION ALLOWED');
    expect(allowed).toContain('Permission granted');
    expect(allowed).toContain('scope: once');

    const denyRequest: InteractionRequest = { id: 'req-deny', ...base };
    repo.createRequest(denyRequest);
    const denied = stripAnsi(await shell.handleInput('/deny req-deny not needed'));
    expect(denied).toContain('ACTION DENIED');
    expect(denied).toContain('Permission denied');
    expect(denied).toContain('agent notified');
  });

  it('writes reassignment lifecycle panels from AgentStreamBus without a new UI channel', () => {
    const streamBus = new AgentStreamBus();
    shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      streamBus,
      output: makeOutput(),
      interactive: false,
    });

    streamBus.publish({
      type: 'investigator_failover',
      stage: 'reassigning',
      timestamp: new Date(),
      runId: 'run-failover',
      taskId: 'TASK-FAILOVER',
      assignmentId: 'asgn-failed',
      agentId: 'agy',
      role: 'researcher',
      failedAgentId: 'agy',
      failedAgentName: 'Google Antigravity',
      replacementAgentId: 'claude',
      replacementAgentName: 'Claude Code',
      reason: 'Quota exhausted',
      resetAt: '2026-09-24T08:00:00.000Z',
    });

    streamBus.publish({
      type: 'investigator_failover',
      stage: 'recovered',
      timestamp: new Date(),
      runId: 'run-failover',
      taskId: 'TASK-FAILOVER',
      assignmentId: 'asgn-replacement',
      agentId: 'claude',
      role: 'researcher',
      failedAgentId: 'agy',
      failedAgentName: 'Google Antigravity',
      replacementAgentId: 'claude',
      replacementAgentName: 'Claude Code',
      reason: 'Quota exhausted',
      resetAt: '2026-09-24T08:00:00.000Z',
    });

    const output = stripAnsi(outputText);
    expect(output).toContain('PROVIDER FAILOVER');
    expect(output).toContain('Google Antigravity');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Quota exhausted');
    expect(output).toContain('2026-09-24T08:00:00.000Z');
    expect(output).toContain('PROVIDER RECOVERED');
    expect(output).toContain('Recovered');
  });
});
