import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { getDefaultConfig } from '@taskforge/shared';
import { InteractiveShell } from '../src/interactive-shell.js';
import { SLASH_COMMANDS } from '../src/slash-menu.js';

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

  it('uses the configured router model for the semantic planner unless PLANNER_MODEL explicitly overrides it', () => {
    const config = getDefaultConfig();
    config.router.model = 'gpt-4o';

    const previousOverride = process.env.PLANNER_MODEL;
    delete process.env.PLANNER_MODEL;

    try {
      const shell = new InteractiveShell({
        repoRoot: tmpDir,
        database: db,
        config,
      });
      shellsToClean.push(shell);

      expect((shell as any).planner.model).toBe('gpt-4o');
    } finally {
      if (previousOverride === undefined) {
        delete process.env.PLANNER_MODEL;
      } else {
        process.env.PLANNER_MODEL = previousOverride;
      }
    }
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
    expect(goalReply).toContain('Estimated agent usage:');
    expect(goalReply).toContain('confidence:');
    expect(goalReply).toContain('Baseline assignments:');
    expect(goalReply).not.toContain('Estimated tokens:');
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

    // Check /stream when an agent is actively tracked -- enters Focus Mode
    // on that assignment (see focus-mode.test.ts for full Focus Mode coverage).
    shell.activityTracker.register({
      taskId: 'task-test-stream',
      assignmentId: 'asgn-test-stream',
      taskTitle: 'Test stream task',
      agentId: 'claude',
      agentName: 'Claude Code',
      role: 'implementer',
      status: 'Building packages...',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
    const streamActiveReply = await shell.handleInput('/stream');
    expect(streamActiveReply).toContain('task-test-stream');
    expect(streamActiveReply).toContain('Claude Code');
    expect(streamActiveReply).toContain('implementer');

    // Exit Focus Mode so the rest of the REPL flow below behaves normally.
    await shell.handleInput('/back');

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
    expect(runsReply).toContain('READY TO APPLY');
    expect(runsReply).toContain('/apply');

    // Check /apply command refuses to touch the target branch while the
    // working tree has uncommitted changes (the test's own sqlite db file
    // lives inside the repo root and keeps changing as the shell runs)
    const applyReply = await shell.handleInput('/apply');
    expect(applyReply).toContain('Could not apply');
    expect(applyReply).toContain('not clean');

    // Check /diff shows the pending changes for the ready run
    const diffReply = await shell.handleInput('/diff');
    expect(diffReply.length).toBeGreaterThan(0);
  });

  it('Requirement 1: revises an active plan end-to-end via natural language feedback in InteractiveShell', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    // 1. Submit initial goal
    const planProposal = await shell.handleInput('create customer billing service and webhook integration');
    expect(planProposal).toContain('✦ Plan Proposal');
    expect(planProposal).toContain('Estimated agent usage:');
    expect(planProposal).toContain('Baseline assignments:');
    expect(planProposal).toContain('structured tasks:');

    const initialGraph = (shell as any).currentGraph;
    expect(initialGraph).toBeDefined();
    const initialCount = initialGraph.getAllTasks().length;
    expect(initialCount).toBeGreaterThan(0);

    // 2. Submit natural language plan revision: add constraint
    const constraintReply = await shell.handleInput('do not modify stripe-secrets.json');
    expect(constraintReply).toContain('✦ Revised Plan');
    expect(constraintReply).toContain('Estimated agent usage:');
    expect(constraintReply).toContain('Baseline assignments:');

    const graphAfterConstraint = (shell as any).currentGraph;
    expect(graphAfterConstraint).toBeDefined();
    expect(graphAfterConstraint.metadata?.revised).toBe(true);
    for (const t of graphAfterConstraint.getAllTasks()) {
      expect(t.contract.forbiddenChanges).toContain('stripe-secrets.json');
    }

    // 3. Submit natural language plan revision: add another task
    const addTaskReply = await shell.handleInput('add task Comprehensive Verification and Integration Tests');
    expect(addTaskReply).toContain('✦ Revised Plan');

    const graphAfterAdd = (shell as any).currentGraph;
    expect(graphAfterAdd.getAllTasks().length).toBe(graphAfterConstraint.getAllTasks().length + 1);
    const lastTask = graphAfterAdd.getAllTasks()[graphAfterAdd.getAllTasks().length - 1];
    expect(lastTask.type).toBe('testing');
    expect(lastTask.title).toContain('Comprehensive Verification');
  });

  it('/help renders the same complete public command catalog as the slash menu', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    const reply = await shell.handleInput('/help');

    for (const command of SLASH_COMMANDS) {
      expect(reply).toContain(command.cmd);
    }
    expect(reply).toContain('/inspect');
    expect(reply).toContain('/focus');
    expect(reply).toContain('/raw');
  });

  it('executes /health command and displays Router, agents, and local database status', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    const reply = await shell.handleInput('/health');
    expect(reply).toContain('TaskForge System Health');
    expect(reply).toContain('Routing Provider:');
    expect(reply).toContain('Agent Fleet:');
    expect(reply).toContain('Local SQLite DB:');
    expect(reply).toContain('test.db');
    expect(reply).toContain('Status:');
  });
});

