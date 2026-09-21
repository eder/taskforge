import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('InteractiveShell /cancel <n> and /raw', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cancel-raw-test-'));
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
    overrides: {
      assignmentId: string;
      taskId: string;
      agentId: string;
      agentName: string;
      role: string;
      logPath?: string;
    },
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
      logPath: overrides.logPath,
    });
  }

  it('/cancel <n> with no live session fails gracefully instead of touching the whole run', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude Code', role: 'architecture_reviewer' });

    const reply = stripAnsi(await shell.handleInput('/cancel 1'));
    expect(reply).toContain('no cancellable session');
    // Never touched the whole-run abort controller.
    expect(shell.activeExecutionController).toBeUndefined();
  });

  it('bare /cancel (no index) keeps its existing whole-run meaning', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    const reply = await shell.handleInput('/cancel');
    expect(reply).toBeDefined();
  });

  it('/cancel <n> reports an out-of-range index without crashing', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude Code', role: 'architecture_reviewer' });

    const reply = await shell.handleInput('/cancel 9');
    expect(reply).toContain('No agent at position 9');
  });

  it('/raw <n> dumps the full persisted log for that assignment', async () => {
    const logPath = path.join(tmpDir, 'agent.log');
    fs.writeFileSync(logPath, 'line one\nline two\nline three\n', 'utf8');

    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, {
      assignmentId: 'asgn-a',
      taskId: 'TASK-01',
      agentId: 'codex',
      agentName: 'Codex',
      role: 'reproduction_engineer',
      logPath,
    });

    const reply = stripAnsi(await shell.handleInput('/raw 1'));
    expect(reply).toContain('Raw log');
    expect(reply).toContain('line one');
    expect(reply).toContain('line two');
    expect(reply).toContain('line three');
  });

  it('/raw with no active agents and nothing focused fails gracefully', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    const reply = await shell.handleInput('/raw');
    expect(reply).toContain('No active agent');
  });

  it('/raw defaults to the currently focused assignment when no index is given', async () => {
    const logA = path.join(tmpDir, 'a.log');
    const logB = path.join(tmpDir, 'b.log');
    fs.writeFileSync(logA, 'from agent A\n', 'utf8');
    fs.writeFileSync(logB, 'from agent B\n', 'utf8');

    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    registerAssignment(shell, { assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'codex', agentName: 'Codex', role: 'reproduction_engineer', logPath: logA });
    registerAssignment(shell, { assignmentId: 'asgn-b', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude', role: 'architecture_reviewer', logPath: logB });

    await shell.handleInput('/stream TASK-01');
    await shell.handleInput('/focus 2');
    const reply = stripAnsi(await shell.handleInput('/raw'));

    expect(reply).toContain('from agent B');
    expect(reply).not.toContain('from agent A');
  });
});
