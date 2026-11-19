import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TaskForgeDatabase,
  RunRepository,
  GoalRepository,
  TaskRepository,
  AssignmentRepository,
  ExecutionRepository,
  EventRepository,
  WorkspaceRepository,
  VerificationRepository,
} from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { DeterministicScheduler } from '../src/deterministic-scheduler.js';
import { describeRunFailures } from '../src/run-failure-report.js';
import { getDefaultConfig } from '@taskforge/shared';

describe('DeterministicScheduler Agent Failover', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-failover');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;
  let baseCommit: string;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'bot@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Failover Test\n', 'utf8');
    baseCommit = await gitService.stageAndCommit('Initial commit', testRepoRoot);
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore
      }
    }
  });

  it('fails over to an alternative agent when preferred agent crashes/fails', async () => {
    const runId = `run-failover-${Date.now()}`;
    const db = new TaskForgeDatabase(':memory:');

    const runRepo = new RunRepository(db);
    const goalRepo = new GoalRepository(db);
    const taskRepo = new TaskRepository(db);
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);

    goalRepo.create({
      id: 'goal-failover',
      description: 'Test resilient agent failover',
      repository: testRepoRoot,
      constraints: [],
      acceptanceCriteria: ['Passes'],
      createdAt: new Date(),
    });

    runRepo.create(runId, 'goal-failover');

    const task: Task = {
      id: 'TASK-01',
      runId,
      goalId: 'goal-failover',
      title: 'Task with flaky primary agent',
      description: 'Should failover from flaky agent to healthy agent',
      type: 'implementation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Write file successfully',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['File exists'],
        dependencies: [],
      },
      acceptanceCriteria: ['File exists'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    taskRepo.create(task);
    const graph = new TaskGraph([task]);

    // Agent 1 fails twice: the first failure must trigger same-agent recovery,
    // and the second must exhaust that repair path and trigger failover.
    const failingAgent = new FakeAgent('failing-codex', 'Failing Codex CLI', [
      {
        shouldFail: true,
        failMessage: 'You have hit your usage limit',
      },
      {
        shouldFail: true,
        failMessage: 'You have hit your usage limit',
      },
    ]);

    // Agent 2 succeeds
    const healthyAgent = new FakeAgent('healthy-claude', 'Healthy Claude Code', [
      {
        writeFile: { path: 'README.md', content: '# Updated by healthy agent\n' },
        gitCommitMessage: 'feat: update readme',
      },
    ]);

    const agentRegistry = new AgentRegistry(false);
    agentRegistry.register(failingAgent);
    agentRegistry.register(healthyAgent);

    const verificationRepo = new VerificationRepository(db);
    const verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
    const integrationService = new IntegrationService(
      testRepoRoot,
      gitService,
      worktreeManager,
      verificationRunner,
      eventRepo,
    );
    const config = getDefaultConfig();
    config.verification.maxReworkCycles = 2;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const progressMessages: string[] = [];
    const scheduler = new DeterministicScheduler({
      runId,
      baseCommit,
      repoRoot: testRepoRoot,
      config,
      graph,
      agentRegistry,
      worktreeManager,
      runRepo,
      taskRepo,
      assignmentRepo,
      executionRepo,
      workspaceRepo,
      eventRepo,
      verificationRunner,
      integrationService,
      preferredAgentMapping: { 'TASK-01': 'failing-codex' },
      onProgress: (msg) => progressMessages.push(msg),
    });

    const result = await scheduler.run();

    expect(result.status, result.error).toBe('completed');
    expect(result.tasksCompleted).toBe(1);
    expect(result.tasksFailed).toBe(0);

    // Verify progress captured same-agent recovery before failover reassignment.
    const recoveryMsg = progressMessages.find((m) =>
      m.includes('returning concrete failure evidence to the same agent'),
    );
    expect(recoveryMsg).toBeDefined();

    const failMsg = progressMessages.find((m) => m.includes('failed'));
    expect(failMsg).toBeDefined();
    expect(failMsg).toContain('Failing Codex CLI');
    expect(failMsg).toContain('usage limit');

    const failoverMsg = progressMessages.find((m) => m.includes('Failover reassigned'));
    expect(failoverMsg).toBeDefined();
    expect(failoverMsg).toContain('Failover reassigned to alternative agent');
  });

  it('reassigns immediately on PROVIDER_AUTH_FAILED without retrying the unauthenticated agent', async () => {
    const runId = `run-auth-failover-${Date.now()}`;
    const db = new TaskForgeDatabase(':memory:');
    const runRepo = new RunRepository(db);
    const goalRepo = new GoalRepository(db);
    const taskRepo = new TaskRepository(db);
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);

    goalRepo.create({
      id: 'goal-auth-failover',
      description: 'Auth failover test',
      repository: testRepoRoot,
      constraints: [],
      acceptanceCriteria: ['Passes'],
      createdAt: new Date(),
    });
    runRepo.create(runId, 'goal-auth-failover');

    const task: Task = {
      id: 'TASK-01',
      runId,
      goalId: 'goal-auth-failover',
      title: 'Update README',
      description: 'Update README',
      type: 'implementation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Update README',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['README updated'],
        dependencies: [],
      },
      acceptanceCriteria: ['README updated'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    taskRepo.create(task);

    let unauthCalls = 0;
    const unauthAgent = new FakeAgent('unauth-claude', 'Claude Code', [
      {
        shouldFail: true,
        failMessage: 'Claude Code authentication failed: oauth_org_not_allowed',
        failCompletionReason: 'PROVIDER_AUTH_FAILED',
      },
    ]);
    const origExec = unauthAgent.execute.bind(unauthAgent);
    unauthAgent.execute = async (assignment, context) => {
      unauthCalls++;
      return origExec(assignment, context);
    };

    const healthyAgent = new FakeAgent('healthy-codex', 'Codex CLI', [
      {
        writeFile: { path: 'README.md', content: '# Updated after auth failover\n' },
        gitCommitMessage: 'docs: update readme',
      },
    ]);

    const agentRegistry = new AgentRegistry(false);
    agentRegistry.register(unauthAgent);
    agentRegistry.register(healthyAgent);

    const verificationRepo = new VerificationRepository(db);
    const verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
    const integrationService = new IntegrationService(
      testRepoRoot,
      gitService,
      worktreeManager,
      verificationRunner,
      eventRepo,
    );
    const config = getDefaultConfig();
    config.verification.maxReworkCycles = 2;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const progressMessages: string[] = [];
    const scheduler = new DeterministicScheduler({
      runId,
      baseCommit,
      repoRoot: testRepoRoot,
      config,
      graph: new TaskGraph([task]),
      agentRegistry,
      worktreeManager,
      runRepo,
      taskRepo,
      assignmentRepo,
      executionRepo,
      workspaceRepo,
      eventRepo,
      verificationRunner,
      integrationService,
      preferredAgentMapping: { 'TASK-01': 'unauth-claude' },
      onProgress: (msg) => progressMessages.push(msg),
    });

    const result = await scheduler.run();

    expect(result.status, result.error).toBe('completed');
    expect(unauthCalls).toBe(1);
    expect(
      progressMessages.some((m) => m.includes('returning concrete failure evidence to the same agent')),
    ).toBe(false);
    expect(progressMessages.some((m) => m.includes('Agent authentication failed: reassigning'))).toBe(
      true,
    );
  });

  it('stops after one attempt on PROVIDER_AUTH_FAILED when no other agent exists, preserving the cause', async () => {
    const runId = `run-auth-only-${Date.now()}`;
    const db = new TaskForgeDatabase(':memory:');
    const runRepo = new RunRepository(db);
    const goalRepo = new GoalRepository(db);
    const taskRepo = new TaskRepository(db);
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);

    goalRepo.create({
      id: 'goal-auth-only',
      description: 'Single unauth agent test',
      repository: testRepoRoot,
      constraints: [],
      acceptanceCriteria: ['Passes'],
      createdAt: new Date(),
    });
    runRepo.create(runId, 'goal-auth-only');

    const task: Task = {
      id: 'TASK-01',
      runId,
      goalId: 'goal-auth-only',
      title: 'Update README',
      description: 'Update README',
      type: 'implementation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Update README',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['README updated'],
        dependencies: [],
      },
      acceptanceCriteria: ['README updated'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    taskRepo.create(task);

    let unauthCalls = 0;
    const unauthAgent = new FakeAgent('unauth-claude', 'Claude Code', [
      {
        shouldFail: true,
        failMessage: 'Claude Code authentication failed: oauth_org_not_allowed',
        failCompletionReason: 'PROVIDER_AUTH_FAILED',
      },
    ]);
    const origExec = unauthAgent.execute.bind(unauthAgent);
    unauthAgent.execute = async (assignment, context) => {
      unauthCalls++;
      return origExec(assignment, context);
    };

    const agentRegistry = new AgentRegistry(false);
    agentRegistry.register(unauthAgent);

    const verificationRepo = new VerificationRepository(db);
    const verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
    const integrationService = new IntegrationService(
      testRepoRoot,
      gitService,
      worktreeManager,
      verificationRunner,
      eventRepo,
    );
    const config = getDefaultConfig();
    config.verification.maxReworkCycles = 2;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const scheduler = new DeterministicScheduler({
      runId,
      baseCommit,
      repoRoot: testRepoRoot,
      config,
      graph: new TaskGraph([task]),
      agentRegistry,
      worktreeManager,
      runRepo,
      taskRepo,
      assignmentRepo,
      executionRepo,
      workspaceRepo,
      eventRepo,
      verificationRunner,
      integrationService,
      preferredAgentMapping: { 'TASK-01': 'unauth-claude' },
    });

    const result = await scheduler.run();

    expect(result.status).toBe('failed');
    expect(unauthCalls).toBe(1);
    const failures = describeRunFailures({ taskRepo, eventRepo }, runId);
    expect(failures[0]?.reason).toContain('oauth_org_not_allowed');
  });
});
