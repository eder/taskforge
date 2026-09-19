import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  TaskForgeDatabase,
  RunRepository,
  TaskRepository,
  AssignmentRepository,
  ExecutionRepository,
  EventRepository,
  VerificationRepository,
  WorkspaceRepository,
  InteractionRepository,
} from '@taskforge/persistence';
import { TaskGraph, Task } from '@taskforge/core';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { AgentRegistry, FakeAgent } from '@taskforge/agents';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { PermissionEngine, QuestionRouter, InteractionGateway } from '@taskforge/execution';
import { DeterministicScheduler } from '@taskforge/scheduler';
import { InteractiveShell } from '@taskforge/conversation';
import { getDefaultConfig } from '@taskforge/shared';
import { createCli } from '../apps/cli/src/cli.js';

describe('TaskForge Spec v2: Agent Interaction Gateway & Human-in-the-Loop', () => {
  let db: TaskForgeDatabase;
  let testRepoRoot: string;
  let git: GitService;

  beforeEach(async () => {
    db = new TaskForgeDatabase(':memory:');
    testRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-spec-v2-'));
    git = new GitService(testRepoRoot);
    await git['exec'](['init', '-b', 'main'], testRepoRoot);
    await git['exec'](['config', 'user.name', 'TaskForge Bot'], testRepoRoot);
    await git['exec'](['config', 'user.email', 'bot@taskforge.dev'], testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Test Project\n', 'utf8');
    await git.stageAndCommit('Initial commit', testRepoRoot);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  describe('1. Permission Engine', () => {
    it('evaluates deterministic permissions for filesystem, commands, and git', () => {
      const engine = new PermissionEngine();

      // Filesystem
      expect(engine.evaluate({ category: 'filesystem', operation: 'workspace_write' })).toBe(
        'allow',
      );
      expect(engine.evaluate({ category: 'filesystem', operation: 'outside_workspace' })).toBe(
        'ask_human',
      );
      expect(engine.evaluate({ category: 'filesystem', operation: 'delete_files' })).toBe(
        'ask_human',
      );

      // Commands
      expect(
        engine.evaluate({ category: 'commands', operation: 'run tests', resource: 'npm test' }),
      ).toBe('allow');
      expect(
        engine.evaluate({ category: 'commands', operation: 'lint', resource: 'eslint .' }),
      ).toBe('allow');
      expect(
        engine.evaluate({
          category: 'commands',
          operation: 'install',
          resource: 'pnpm add lodash',
        }),
      ).toBe('ask_human');
      expect(
        engine.evaluate({ category: 'commands', operation: 'sudo', resource: 'sudo rm -rf /' }),
      ).toBe('deny');

      // Git
      expect(engine.evaluate({ category: 'git', operation: 'commit' })).toBe('allow');
      expect(engine.evaluate({ category: 'git', operation: 'push' })).toBe('ask_human');
      expect(engine.evaluate({ category: 'git', operation: 'force_push' })).toBe('deny');
      expect(engine.evaluate({ category: 'git', operation: 'merge_main' })).toBe('deny');
    });

    it('respects recorded approvals with task and project scopes', () => {
      const engine = new PermissionEngine();
      expect(
        engine.evaluate({
          category: 'commands',
          operation: 'install',
          resource: 'axios',
          taskId: 'TASK-1',
        }),
      ).toBe('ask_human');

      engine.recordApproval('commands', 'axios', 'allow', 'task', 'TASK-1');
      expect(
        engine.evaluate({
          category: 'commands',
          operation: 'install',
          resource: 'axios',
          taskId: 'TASK-1',
        }),
      ).toBe('allow');
      expect(
        engine.evaluate({
          category: 'commands',
          operation: 'install',
          resource: 'axios',
          taskId: 'TASK-2',
        }),
      ).toBe('ask_human');

      engine.recordApproval('commands', 'axios', 'allow', 'project');
      expect(
        engine.evaluate({
          category: 'commands',
          operation: 'install',
          resource: 'axios',
          taskId: 'TASK-2',
        }),
      ).toBe('allow');
    });
  });

  describe('2. Question Router', () => {
    it('resolves questions across AUTO_RESOLVE, POLICY_ALLOW, POLICY_DENY, and ASK_HUMAN', () => {
      const router = new QuestionRouter();
      const contract = {
        objective: 'Build Auth Service',
        allowedScope: ['src/auth/*'],
        forbiddenChanges: ['package.json'],
        acceptanceCriteria: ['Tests pass'],
        dependencies: [],
      };

      // 1. AUTO_RESOLVE
      const res1 = router.route({
        prompt: 'What is the allowed scope for this task?',
        taskContract: contract,
      });
      expect(res1.outcome).toBe('AUTO_RESOLVE');
      expect(res1.answer).toContain('src/auth/*');

      // 2. POLICY_DENY
      const res2 = router.route({
        prompt: 'Can I run sudo to install system packages?',
      });
      expect(res2.outcome).toBe('POLICY_DENY');

      // 3. POLICY_ALLOW
      const res3 = router.route({
        prompt: 'Can I execute tests to verify code?',
      });
      expect(res3.outcome).toBe('POLICY_ALLOW');

      // 4. ROUTE_TO_AGENT
      const res4 = router.route({
        prompt: 'What architecture pattern should we use for repository persistence?',
        availablePeers: [{ id: 'claude', role: 'architecture_reviewer' }],
      });
      expect(res4.outcome).toBe('ROUTE_TO_AGENT');
      expect(res4.targetAgentId).toBe('claude');

      // 5. ASK_HUMAN
      const res5 = router.route({
        prompt: 'Should user passwords expire after 30 or 90 days?',
      });
      expect(res5.outcome).toBe('ASK_HUMAN');
    });
  });

  describe('3. Persistence & Interaction Gateway Primitives', () => {
    it('persists requests and responses in SQLite and resolves pending interactions', async () => {
      const repo = new InteractionRepository(db);
      const gateway = new InteractionGateway({ interactionRepo: repo });

      repo.createRequest({
        id: 'req-test-1',
        runId: 'run-1',
        taskId: 'TASK-1',
        assignmentId: 'asgn-1',
        agentId: 'fake-agent',
        type: 'permission',
        prompt: 'Install package axios',
        category: 'commands',
        resource: 'axios',
        status: 'pending',
        priority: 'normal',
        createdAt: new Date().toISOString(),
      });

      const pending = repo.getPendingRequests('run-1');
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('req-test-1');

      repo.createResponse({
        id: 'resp-test-1',
        requestId: 'req-test-1',
        decision: 'allow',
        source: 'human',
        scope: 'task',
        createdAt: new Date().toISOString(),
      });
      repo.updateRequestStatus('req-test-1', 'resolved');

      const updated = repo.getRequest('req-test-1');
      expect(updated?.status).toBe('resolved');
      const responses = repo.getResponsesForRequest('req-test-1');
      expect(responses).toHaveLength(1);
      expect(responses[0].decision).toBe('allow');

      gateway.cancelAll();
    });
  });

  describe('4. Spec v2 Criterion 8: FakeAgent waiting for permission while an unrelated task continues', () => {
    it('demonstrates non-blocking parallel execution: TASK-2 completes while TASK-1 waits for permission', async () => {
      const baseCommit = await git.getHeadCommit();
      const config = getDefaultConfig();
      config.execution.maxParallelTasks = 3;
      config.verification.tests = false;
      config.verification.lint = false;
      config.verification.typecheck = false;
      config.verification.review = false;

      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const assignmentRepo = new AssignmentRepository(db);
      const executionRepo = new ExecutionRepository(db);
      const eventRepo = new EventRepository(db);
      const verificationRepo = new VerificationRepository(db);
      const workspaceRepo = new WorkspaceRepository(db);
      const interactionRepo = new InteractionRepository(db);

      const gateway = new InteractionGateway({ config, interactionRepo });

      const agentRegistry = new AgentRegistry();

      // Agent 1: will pause for permission
      const agent1 = new FakeAgent('agent-1', 'Agent 1');
      agent1.addAction({
        requestPermission: {
          category: 'commands',
          operation: 'package_install',
          resource: '@fastify/oauth2',
          prompt: 'Install @fastify/oauth2',
        },
        writeFile: { path: 'feature-1.txt', content: 'feature 1 done' },
        gitCommitMessage: 'feat(TASK-1): add feature 1',
      });

      // Agent 2: independent, completes immediately
      const agent2 = new FakeAgent('agent-2', 'Agent 2');
      agent2.addAction({
        writeFile: { path: 'feature-2.txt', content: 'feature 2 done' },
        gitCommitMessage: 'feat(TASK-2): add feature 2',
      });

      agentRegistry.register(agent1);
      agentRegistry.register(agent2);

      const runId = 'run-parallel-perm-test';
      runRepo.create(runId);

      const graph = new TaskGraph();
      const task1: Task = {
        id: 'TASK-1',
        title: 'Task 1 requiring permission',
        description: 'Needs @fastify/oauth2',
        type: 'implementation',
        status: 'ready',
        dependencies: [],
        contract: {
          objective: 'Task 1',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: [],
          dependencies: [],
        },
        acceptanceCriteria: [],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const task2: Task = {
        id: 'TASK-2',
        title: 'Task 2 independent',
        description: 'Independent task',
        type: 'implementation',
        status: 'ready',
        dependencies: [],
        contract: {
          objective: 'Task 2',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: [],
          dependencies: [],
        },
        acceptanceCriteria: [],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      graph.addTask(task1);
      graph.addTask(task2);
      taskRepo.create({ ...task1, runId });
      taskRepo.create({ ...task2, runId });

      const worktreeManager = new WorktreeManager(testRepoRoot, config.execution.worktreesDir);
      const verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
      const integrationService = new IntegrationService(
        testRepoRoot,
        git,
        worktreeManager,
        verificationRunner,
        eventRepo,
      );

      const scheduler = new DeterministicScheduler({
        runId,
        baseCommit,
        repoRoot: testRepoRoot,
        config,
        graph,
        agentRegistry,
        preferredAgentMapping: {
          'TASK-1': 'agent-1',
          'TASK-2': 'agent-2',
        },
        worktreeManager,
        gitService: git,
        verificationRunner,
        integrationService,
        runRepo,
        taskRepo,
        assignmentRepo,
        executionRepo,
        eventRepo,
        workspaceRepo,
        interactionGateway: gateway,
      });

      // Start scheduler in background
      const runPromise = scheduler.run();

      // Wait until TASK-2 is integrated while TASK-1 is waiting for permission!
      let t2 = graph.getTask('TASK-2');
      for (let i = 0; i < 40 && t2?.status !== 'integrated'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        t2 = graph.getTask('TASK-2');
      }
      expect(t2?.status).toBe('integrated');

      const t1Waiting = graph.getTask('TASK-1');
      expect(t1Waiting?.status).toBe('waiting_permission');

      const pending = gateway.getPendingRequests();
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(pending[0].resource).toBe('@fastify/oauth2');

      // Now approve the permission for TASK-1
      gateway.resolve(pending[0].id, 'allow', undefined, 'task');

      // Await scheduler completion
      const result = await runPromise;
      expect(result.status).toBe('completed');
      expect(result.tasksCompleted).toBe(2);

      const t1 = graph.getTask('TASK-1');
      expect(t1?.status).toBe('integrated');
    });
  });

  describe('5. Spec v2 Criterion 9: Headless unknown permission deny/block without hanging', () => {
    it('denies unknown permission automatically in headless mode without blocking or hanging', async () => {
      const baseCommit = await git.getHeadCommit();
      const config = getDefaultConfig();
      config.ui.mode = 'headless';
      config.headless.onUnknownPermission = 'deny';
      config.verification.maxReworkCycles = 0;

      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const assignmentRepo = new AssignmentRepository(db);
      const executionRepo = new ExecutionRepository(db);
      const eventRepo = new EventRepository(db);
      const verificationRepo = new VerificationRepository(db);
      const workspaceRepo = new WorkspaceRepository(db);
      const interactionRepo = new InteractionRepository(db);

      const gateway = new InteractionGateway({ config, interactionRepo });

      const agent = new FakeAgent('agent-headless', 'Agent Headless');
      agent.addAction({
        requestPermission: {
          category: 'filesystem',
          operation: 'write_outside_disk',
          resource: '/etc/passwd',
          prompt: 'Write to /etc/passwd',
        },
      });

      const agentRegistry = new AgentRegistry();
      agentRegistry.register(agent);

      const runId = 'run-headless-deny-test';
      runRepo.create(runId);

      const graph = new TaskGraph();
      const task: Task = {
        id: 'TASK-DENY',
        title: 'Task requesting dangerous write',
        description: 'Should be denied',
        type: 'implementation',
        status: 'ready',
        dependencies: [],
        contract: {
          objective: 'Denied task',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: [],
          dependencies: [],
        },
        acceptanceCriteria: [],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      graph.addTask(task);
      taskRepo.create({ ...task, runId });

      const worktreeManager = new WorktreeManager(testRepoRoot, config.execution.worktreesDir);
      const verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
      const integrationService = new IntegrationService(
        testRepoRoot,
        git,
        worktreeManager,
        verificationRunner,
        eventRepo,
      );

      const scheduler = new DeterministicScheduler({
        runId,
        baseCommit,
        repoRoot: testRepoRoot,
        config,
        graph,
        agentRegistry,
        preferredAgentMapping: { 'TASK-DENY': 'agent-headless' },
        worktreeManager,
        gitService: git,
        verificationRunner,
        integrationService,
        runRepo,
        taskRepo,
        assignmentRepo,
        executionRepo,
        eventRepo,
        workspaceRepo,
        interactionGateway: gateway,
      });

      const startTime = Date.now();
      const result = await scheduler.run();
      const duration = Date.now() - startTime;

      // Must terminate quickly without hanging!
      expect(duration).toBeLessThan(5000);
      expect(result.status).toBe('failed');
      expect(result.tasksFailed).toBe(1);
    });
  });

  describe('6. Conversational Approvals in Interactive Shell', () => {
    it('processes natural language approvals: "allow installation only for this task"', async () => {
      const shell = new InteractiveShell({
        repoRoot: testRepoRoot,
        database: db,
      });

      // Inject pending interaction
      const interactionRepo = new InteractionRepository(db);
      interactionRepo.createRequest({
        id: 'req-conv-1',
        runId: 'run-conv',
        taskId: 'TASK-14',
        assignmentId: 'asgn-14',
        agentId: 'codex',
        type: 'permission',
        prompt: 'Agent wants to install: @fastify/oauth2',
        category: 'commands',
        resource: '@fastify/oauth2',
        status: 'pending',
        priority: 'normal',
        createdAt: new Date().toISOString(),
      });

      // Query /pending (defaults to English)
      const pendingResponse = await shell.handleInput('/pending');
      expect(pendingResponse).toContain('Pending interactions awaiting approval');
      expect(pendingResponse).toContain('@fastify/oauth2');

      // Operator natural approval
      const approvalResponse = await shell.handleInput('allow installation only for this task');
      expect(approvalResponse).toContain('allowed');
      expect(approvalResponse).toContain('scope: task');
    });
  });

  describe('7. Headless CLI Commands: tf exec and tf inspect', () => {
    it('configures tf exec and tf inspect in CLI program', () => {
      const cli = createCli();
      const execCmd = cli.commands.find((c) => c.name() === 'exec');
      expect(execCmd).toBeDefined();
      expect(execCmd?.description()).toContain('headless');

      const inspectCmd = cli.commands.find((c) => c.name() === 'inspect');
      expect(inspectCmd).toBeDefined();
      expect(inspectCmd?.description()).toContain('Inspect');
    });
  });
});
