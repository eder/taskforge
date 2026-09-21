import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('InteractiveShell Focus Mode', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-focus-mode-test-'));
    db = new TaskForgeDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    for (const shell of shellsToClean) {
      shell.close();
    }
    shellsToClean.length = 0;
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function registerAssignment(
    shell: InteractiveShell,
    overrides: { assignmentId: string; taskId: string; agentId: string; agentName: string; role: string },
  ) {
    shell.activityTracker.register({
      taskId: overrides.taskId,
      assignmentId: overrides.assignmentId,
      taskTitle: 'Evaluate the architecture',
      agentId: overrides.agentId,
      agentName: overrides.agentName,
      role: overrides.role,
      status: 'Working...',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
  }

  it('/stream with a single active assignment enters focus mode on it', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, {
      assignmentId: 'asgn-a',
      taskId: 'TASK-01',
      agentId: 'claude',
      agentName: 'Claude Code',
      role: 'architecture_reviewer',
    });

    const view = stripAnsi(await shell.handleInput('/stream TASK-01'));
    expect(view).toContain('TASK-01');
    expect(view).toContain('Claude Code');
    expect(view).toContain('architecture_reviewer');
  });

  it('shows every concurrent assignment on the same task as a distinct tab, not collapsed by taskId', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-codex', taskId: 'TASK-01', agentId: 'codex', agentName: 'Codex', role: 'reproduction_engineer' });
    registerAssignment(shell, { assignmentId: 'asgn-agy', taskId: 'TASK-01', agentId: 'agy', agentName: 'Antigravity', role: 'researcher' });
    registerAssignment(shell, { assignmentId: 'asgn-claude', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude', role: 'architecture_reviewer' });

    const view = stripAnsi(await shell.handleInput('/stream TASK-01'));
    expect(view).toContain('Codex');
    expect(view).toContain('reproduction_engineer');
    expect(view).toContain('Antigravity');
    expect(view).toContain('researcher');
    expect(view).toContain('Claude');
    expect(view).toContain('architecture_reviewer');
  });

  it('publishing a stream event for the focused assignment appends live to the viewport, without another /stream call', async () => {
    const outStream = new PassThrough();
    const chunks: string[] = [];
    outStream.on('data', (c) => chunks.push(c.toString()));

    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db, output: outStream, interactive: false });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude Code', role: 'architecture_reviewer' });

    await shell.handleInput('/stream TASK-01');
    chunks.length = 0; // only care about what happens AFTER entering focus mode

    shell.streamBus.publish({
      type: 'file_read',
      path: 'server/app.py',
      timestamp: new Date(),
      runId: 'run-1',
      taskId: 'TASK-01',
      assignmentId: 'asgn-a',
      agentId: 'claude',
      role: 'architecture_reviewer',
    });

    const written = stripAnsi(chunks.join(''));
    expect(written).toContain('Read');
    expect(written).toContain('server/app.py');
  });

  it('/focus <n> switches to another assignment on the same task', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-1', taskId: 'TASK-01', agentId: 'codex', agentName: 'Codex', role: 'reproduction_engineer' });
    registerAssignment(shell, { assignmentId: 'asgn-2', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude', role: 'architecture_reviewer' });

    await shell.handleInput('/stream TASK-01');
    const view = stripAnsi(await shell.handleInput('/focus 2'));

    expect(view).toContain('Claude');
    expect(view).toContain('architecture_reviewer');
  });

  it('/back exits focus mode and plain text is no longer routed to the agent', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude Code', role: 'architecture_reviewer' });

    await shell.handleInput('/stream TASK-01');
    const backReply = await shell.handleInput('/back');
    expect(stripAnsi(backReply)).toContain('overview');

    const reply = await shell.handleInput('who is available?');
    expect(reply).not.toContain('sent to');
  });

  it('while focused, plain text is routed toward the agent (not parsed as a new goal), even with no live session', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude Code', role: 'architecture_reviewer' });

    await shell.handleInput('/stream TASK-01');
    const reply = await shell.handleInput('also consider provider lock-in and Groq compatibility');

    // No live session is registered in this unit test (no real run in
    // progress), so the routing must fail gracefully rather than silently
    // being reinterpreted as a brand-new goal submission.
    expect(reply).not.toContain('Generating structured task graph');
    expect(reply).toContain('asgn-a');
  });

  it('slash commands still work while focused (e.g. /back), not swallowed by agent messaging', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude Code', role: 'architecture_reviewer' });

    await shell.handleInput('/stream TASK-01');
    const reply = await shell.handleInput('/back');
    expect(reply).not.toContain('sent to');
  });
});
