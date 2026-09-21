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

describe('InteractiveShell /tasks live view', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-tasks-view-test-'));
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

  it('shows every concurrent assignment on a task with agent, role, duration and current activity', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    shell.activityTracker.register({
      taskId: 'TASK-01',
      assignmentId: 'asgn-codex',
      taskTitle: 'Evaluate Agents SDK',
      agentId: 'codex',
      agentName: 'Codex',
      role: 'reproduction_engineer',
      status: 'Reading context_retrieval.py',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
    shell.activityTracker.register({
      taskId: 'TASK-01',
      assignmentId: 'asgn-claude',
      taskTitle: 'Evaluate Agents SDK',
      agentId: 'claude',
      agentName: 'Claude',
      role: 'architecture_reviewer',
      status: 'Comparing orchestration boundaries',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });

    const reply = stripAnsi(await shell.handleInput('/tasks'));

    expect(reply).toContain('Active Tasks');
    expect(reply).toContain('TASK-01');
    expect(reply).toContain('Codex');
    expect(reply).toContain('reproduction_engineer');
    expect(reply).toContain('Reading context_retrieval.py');
    expect(reply).toContain('Claude');
    expect(reply).toContain('architecture_reviewer');
    expect(reply).toContain('Comparing orchestration boundaries');
  });

  it('falls back to the planned-tasks view when no agents are active', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    const reply = await shell.handleInput('/tasks');
    expect(reply).toContain('No active tasks in this run.');
  });
});
