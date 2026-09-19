import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

describe('InteractiveShell (REPL)', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-shell-test-'));
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
      // ignore db close error
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore directory cleanup error
    }
  });

  it('renders initial startup banner with repo and agent status', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);
    const banner = await shell.renderBanner();

    expect(banner).toContain('TaskForge');
    expect(banner).toContain('Agents');
    expect(banner).toContain('Router');
  });

  it('processes user commands in conversational REPL', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    // Check agents command
    const defaultAgentsReply = await shell.handleInput('/agents');
    expect(defaultAgentsReply).toContain('Available agents:');

    // Check agents inspection via natural language
    const agentReply = await shell.handleInput('who is available?');
    expect(agentReply).toContain('Available agents:');

    // Check pause and resume
    const pauseReply = await shell.handleInput('pause execution');
    expect(pauseReply).toContain('Execution paused safely');

    const resumeReply = await shell.handleInput('resume execution');
    expect(resumeReply).toContain('Execution resumed');

    // Check constraint command
    const constraintReply = await shell.handleInput('do not change .env files');
    expect(constraintReply).toContain('Constraint added successfully');

    // Check plan proposal flow
    const goalReply = await shell.handleInput('create application health endpoint');
    expect(goalReply).toContain('Understood. Recommended strategy:');
    expect(goalReply).toContain('structured tasks:');
    expect(goalReply).toContain('Do you want me to execute?');

    // Check /plan
    const planReply = await shell.handleInput('/plan');
    expect(planReply).toContain('Current task plan:');

    // Check approval and execution with 'yes --fake'
    const approveReply = await shell.handleInput('yes --fake');
    expect(approveReply).toContain('Plan executed successfully!');

    // Check second plan and approve with 'y --fake'
    await shell.handleInput('create metrics dashboard');
    const yReply = await shell.handleInput('y --fake');
    expect(yReply).toContain('Plan executed successfully!');

    // Check /stream when idle
    const streamIdleReply = await shell.handleInput('/stream');
    expect(streamIdleReply).toContain('No active agent tasks currently streaming');

    // Check /stream when an agent is actively tracked
    shell.activityTracker.register({
      taskId: 'task-test-stream',
      agentId: 'claude',
      agentName: 'Claude Code',
      status: 'Building packages...',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
    const streamActiveReply = await shell.handleInput('/stream');
    expect(streamActiveReply).toContain('Live Stream:');
    expect(streamActiveReply).toContain('task-test-stream');
    expect(streamActiveReply).toContain('Claude Code');
    expect(streamActiveReply).toContain('[1: task-test-stream]');

    // Check /cancel command
    const cancelReply = await shell.handleInput('/cancel');
    expect(cancelReply).toBeDefined();

    // Check background asyncExecution mode
    const asyncDb = new TaskForgeDatabase(path.join(tmpDir, 'async.db'));
    const asyncShell = new InteractiveShell({
      asyncExecution: true,
      repoRoot: tmpDir,
      database: asyncDb,
    });
    shellsToClean.push(asyncShell);
    await asyncShell.handleInput('create webhook router');
    const asyncApproveReply = await asyncShell.handleInput('y --fake');
    expect(asyncApproveReply).toContain('Execution running in background');
    expect(asyncApproveReply).toContain('REPL is active');
    expect(asyncShell.activeExecutionController).toBeDefined();

    // Cancel active background execution
    const bgCancelReply = await asyncShell.handleInput('/cancel');
    expect(bgCancelReply).toContain('Plan execution cancelled by user');
    expect(asyncShell.activeExecutionController).toBeUndefined();

    // Check /runs command
    const runsReply = await shell.handleInput('/runs');
    expect(runsReply).toContain('TaskForge Runs History');
    expect(runsReply).toContain('taskforge/run-');
    expect(runsReply).toContain('git merge taskforge/run-');
  });
});
