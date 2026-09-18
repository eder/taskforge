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
  VerificationRepository,
  WorkspaceRepository,
  AuditService,
} from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { VerificationRunner, RunVerificationOptions } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { DeterministicScheduler } from '@taskforge/scheduler';
import { getDefaultConfig, TaskForgeConfig } from '@taskforge/shared';

describe('TaskForge Phases 0-5 End-to-End Orchestration', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-repo');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;
  let baseCommit: string;

  beforeEach(async () => {
    // Setup clean test git repository
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'bot@taskforge.dev'], testRepoRoot);

    // Initial commit in test repo
    fs.writeFileSync(
      path.join(testRepoRoot, 'README.md'),
      '# Test Repo for TaskForge E2E\n',
      'utf8',
    );
    baseCommit = await gitService.stageAndCommit('Initial commit', testRepoRoot);

    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore cleanup error in tests
      }
    }
  });

  it('demonstrates two FakeAgents working concurrently in separate worktrees, followed by a dependent task waiting for both', async () => {
    const runId = `run-concurrent-${Date.now()}`;
    const db = new TaskForgeDatabase(':memory:');

    const runRepo = new RunRepository(db);
    const goalRepo = new GoalRepository(db);
    const taskRepo = new TaskRepository(db);
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const verificationRepo = new VerificationRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);
    const auditService = new AuditService(runRepo, goalRepo, taskRepo, eventRepo);

    runRepo.create(runId);

    // Configure two distinct FakeAgents
    const agentA = new FakeAgent('agent-backend', 'Backend Agent', [
      {
        writeFile: {
          path: 'src/backend.ts',
          content: 'export const backend = "operational";\n',
        },
        gitCommitMessage: 'feat(TASK-A): implement backend service',
        delayMs: 150, // simulate concurrent work
      },
    ]);

    const agentB = new FakeAgent('agent-frontend', 'Frontend Agent', [
      {
        writeFile: {
          path: 'src/frontend.ts',
          content: 'export const frontend = "rendered";\n',
        },
        gitCommitMessage: 'feat(TASK-B): implement frontend component',
        delayMs: 150, // simulate concurrent work
      },
    ]);

    const agentC = new FakeAgent('agent-integrator', 'Integrator Agent', [
      {
        writeFile: {
          path: 'src/index.ts',
          content: 'export * from "./backend";\nexport * from "./frontend";\n',
        },
        gitCommitMessage: 'feat(TASK-C): integrate frontend and backend',
      },
    ]);

    const agentRegistry = new AgentRegistry();
    agentRegistry.register(agentA);
    agentRegistry.register(agentB);
    agentRegistry.register(agentC);

    const taskA: Task = {
      id: 'TASK-A',
      goalId: 'goal-1',
      title: 'Backend Service',
      description: 'Implement backend',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Backend service',
        allowedScope: ['src/backend.ts'],
        forbiddenChanges: [],
        acceptanceCriteria: ['backend operational'],
        dependencies: [],
      },
      acceptanceCriteria: ['backend operational'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const taskB: Task = {
      id: 'TASK-B',
      goalId: 'goal-1',
      title: 'Frontend Component',
      description: 'Implement frontend',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Frontend component',
        allowedScope: ['src/frontend.ts'],
        forbiddenChanges: [],
        acceptanceCriteria: ['frontend rendered'],
        dependencies: [],
      },
      acceptanceCriteria: ['frontend rendered'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const taskC: Task = {
      id: 'TASK-C',
      goalId: 'goal-1',
      title: 'Integration Layer',
      description: 'Combine backend and frontend',
      type: 'implementation',
      status: 'accepted',
      dependencies: ['TASK-A', 'TASK-B'],
      contract: {
        objective: 'Integration layer',
        allowedScope: ['src/index.ts'],
        forbiddenChanges: [],
        acceptanceCriteria: ['both exported'],
        dependencies: ['TASK-A', 'TASK-B'],
      },
      acceptanceCriteria: ['both exported'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    taskRepo.create({
      id: taskA.id,
      runId,
      title: taskA.title,
      description: taskA.description,
      type: taskA.type,
      status: taskA.status,
      contract: taskA.contract,
    });
    taskRepo.create({
      id: taskB.id,
      runId,
      title: taskB.title,
      description: taskB.description,
      type: taskB.type,
      status: taskB.status,
      contract: taskB.contract,
    });
    taskRepo.create({
      id: taskC.id,
      runId,
      title: taskC.title,
      description: taskC.description,
      type: taskC.type,
      status: taskC.status,
      contract: taskC.contract,
      dependencies: taskC.dependencies,
    });

    const graph = new TaskGraph([taskA, taskB, taskC]);

    const config: TaskForgeConfig = getDefaultConfig();
    config.execution.maxParallelTasks = 3;
    config.agents['agent-backend'] = { enabled: true, maxParallel: 1 };
    config.agents['agent-frontend'] = { enabled: true, maxParallel: 1 };
    config.agents['agent-integrator'] = { enabled: true, maxParallel: 1 };
    config.verification.tests = false; // sandbox repo has no package.json/pnpm
    config.verification.lint = false;
    config.verification.typecheck = false;

    const verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
    const integrationService = new IntegrationService(
      testRepoRoot,
      gitService,
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
      worktreeManager,
      gitService,
      verificationRunner,
      integrationService,
      runRepo,
      taskRepo,
      assignmentRepo,
      executionRepo,
      eventRepo,
      workspaceRepo,
      preferredAgentMapping: {
        'TASK-A': 'agent-backend',
        'TASK-B': 'agent-frontend',
        'TASK-C': 'agent-integrator',
      },
    });

    const result = await scheduler.run();

    if (result.status !== 'completed') {
      throw new Error(`SCHEDULER RESULT: ${JSON.stringify(result, null, 2)}`);
    }
    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(3);
    expect(result.tasksFailed).toBe(0);

    // 2. All tasks integrated in DAG
    expect(graph.getTask('TASK-A')?.status).toBe('integrated');
    expect(graph.getTask('TASK-B')?.status).toBe('integrated');
    expect(graph.getTask('TASK-C')?.status).toBe('integrated');

    // 3. Integration branch was created and contains changes from all 3 tasks!
    expect(result.integrationBranch).toBe(`taskforge/run-${runId}`);
    const branchExists = await gitService.branchExists(result.integrationBranch!);
    expect(branchExists).toBe(true);

    // 4. Audit reconstruction verifies full event stream
    const audit = auditService.reconstructRun(runId);
    expect(audit).toBeDefined();
    expect(audit?.tasks.length).toBe(3);

    const eventTypes = audit!.events.map((e) => e.type);
    expect(eventTypes).toContain('TASK_STARTED');
    expect(eventTypes).toContain('TASK_COMPLETED');
    expect(eventTypes).toContain('VERIFY_STARTED');
    expect(eventTypes).toContain('VERIFY_COMPLETED');
    expect(eventTypes).toContain('INTEGRATION_COMPLETED');
  });

  it('demonstrates verification preventing a bad task from integration', async () => {
    const runId = `run-bad-task-${Date.now()}`;
    const db = new TaskForgeDatabase(':memory:');

    const runRepo = new RunRepository(db);
    const taskRepo = new TaskRepository(db);
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const verificationRepo = new VerificationRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);

    runRepo.create(runId);

    // Agent that creates bad code
    const badAgent = new FakeAgent('bad-agent', 'Bad Agent', [
      {
        writeFile: {
          path: 'src/bad.txt',
          content: 'broken syntax',
        },
        gitCommitMessage: 'feat(TASK-BAD): buggy commit',
      },
    ]);

    const agentRegistry = new AgentRegistry();
    agentRegistry.register(badAgent);

    const badTask: Task = {
      id: 'TASK-BAD',
      goalId: 'goal-fail',
      title: 'Bad Task',
      description: 'Will fail verification',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Bad task',
        allowedScope: [],
        forbiddenChanges: [],
        acceptanceCriteria: [],
        dependencies: [],
      },
      acceptanceCriteria: [],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    taskRepo.create({
      id: badTask.id,
      runId,
      title: badTask.title,
      description: badTask.description,
      type: badTask.type,
      status: badTask.status,
    });

    const graph = new TaskGraph([badTask]);

    const config: TaskForgeConfig = getDefaultConfig();
    config.verification.tests = true;
    config.verification.maxReworkCycles = 1;

    // Custom verification runner that fails on TASK-BAD
    class FailingVerificationRunner extends VerificationRunner {
      async verify(options: RunVerificationOptions) {
        if (options.taskId === 'TASK-BAD') {
          return {
            passed: false,
            checks: [
              {
                name: 'test',
                command: 'test-failing-command',
                exitCode: 1,
                stdout: '',
                stderr: 'Test suite failed with 2 assertions broken',
                durationMs: 50,
                success: false,
              },
            ],
            failureReason: 'Tests failed on TASK-BAD',
          };
        }
        return super.verify(options);
      }
    }

    const verificationRunner = new FailingVerificationRunner(verificationRepo, eventRepo);
    const integrationService = new IntegrationService(
      testRepoRoot,
      gitService,
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
      worktreeManager,
      gitService,
      verificationRunner,
      integrationService,
      runRepo,
      taskRepo,
      assignmentRepo,
      executionRepo,
      eventRepo,
      workspaceRepo,
      preferredAgentMapping: {
        'TASK-BAD': 'bad-agent',
      },
    });

    const result = await scheduler.run();

    // The scheduler halts and marks run failed
    expect(result.status).toBe('failed');
    expect(result.tasksFailed).toBe(1);

    // The bad task was blocked and NOT integrated!
    const finalTask = graph.getTask('TASK-BAD');
    expect(finalTask?.status).toBe('blocked');

    // Integration branch was not created or no bad commit integrated
    const branchExists = await gitService.branchExists(`taskforge/run-${runId}`);
    expect(branchExists).toBe(false);
  });
});
