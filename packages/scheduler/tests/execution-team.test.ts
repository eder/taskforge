import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TaskForgeDatabase,
  AssignmentRepository,
  EventRepository,
} from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { NegotiationManager, AgentPreflightEvaluator } from '@taskforge/negotiation';
import { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { getDefaultConfig } from '@taskforge/shared';

describe('RunOrchestrator ExecutionTeam & Collaborative Staffing', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-team');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Team Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'team@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Team Execution Test\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
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

  it('transforms pair routing decision into real 2-agent execution team with distinct assignments', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const registry = new AgentRegistry(false);

    const leadAgent = new FakeAgent('codex-lead', 'Codex Lead', [
      {
        writeFile: {
          path: 'feature.ts',
          content: 'export const feature = "implemented by codex";\n',
        },
        gitCommitMessage: 'feat: implement feature',
      },
    ]);
    const reviewerAgent = new FakeAgent('claude-reviewer', 'Claude Reviewer', [
      {
        writeFile: {
          path: 'feature.test.ts',
          content: 'import { feature } from "./feature";\n',
        },
        gitCommitMessage: 'test: reviewed and validated by claude',
      },
    ]);

    registry.register(leadAgent);
    registry.register(reviewerAgent);

    // Mock router that decides "pair" strategy with 2 roles
    const pairRouter: RoutingProvider = {
      id: 'mock-pair-router',
      route: async () => ({
        strategy: 'pair',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement core functionality',
            preferredAgent: 'codex-lead',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review and add test validation',
            preferredAgent: 'claude-reviewer',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: false,
        },
        reason: 'High complexity requires pair programming with dedicated reviewer',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: pairRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-PAIR-1',
      title: 'Build secure authentication module',
      description: 'Implement auth module with token rotation',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-PAIR-1',
        objective: 'Implement secure auth',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Auth module exported', 'Tests pass'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Implement secure auth module', {
      preplannedGraph: graph,
    });

    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(1);

    // Verify N real assignments were created in the repository
    const allAssignments = assignmentRepo.listByTask('TASK-PAIR-1');
    expect(allAssignments.length).toBe(2);

    const leadAssignment = allAssignments.find((a) => a.agentId === 'codex-lead');
    const reviewerAssignment = allAssignments.find((a) => a.agentId === 'claude-reviewer');

    expect(leadAssignment).toBeDefined();
    expect(leadAssignment?.role).toBe('implementer');
    expect(leadAssignment?.status).toBe('completed');

    expect(reviewerAssignment).toBeDefined();
    expect(reviewerAssignment?.role).toBe('reviewer');
    expect(reviewerAssignment?.status).toBe('completed');

    // Verify both agents were invoked
    expect(leadAgent.executedAssignments.length).toBe(1);
    expect(reviewerAgent.executedAssignments.length).toBe(1);

    db.close();
  });

  it('closes the loop: preflight recommend_collaboration triggers pair staffing and execution', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const eventRepo = new EventRepository(db);
    const registry = new AgentRegistry(false);

    const workerA = new FakeAgent('codex-worker', 'Codex Worker', [
      {
        writeFile: { path: 'arch.ts', content: 'export const arch = "refactored";\n' },
        gitCommitMessage: 'refactor: overhauled module architecture',
      },
    ]);
    const workerB = new FakeAgent('claude-worker', 'Claude Worker', [
      {
        writeFile: { path: 'arch-review.txt', content: 'Architecture validated.\n' },
        gitCommitMessage: 'docs: architecture review signed off',
      },
    ]);

    registry.register(workerA);
    registry.register(workerB);

    // Preflight evaluator will encounter an architecture refactor with unbounded scope
    // and return recommend_collaboration
    const preflightEvaluator = new AgentPreflightEvaluator();
    const negotiator = new NegotiationManager(preflightEvaluator, eventRepo, db);

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      negotiator,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-ARCH-REFACTOR',
      title: 'Global architecture refactoring',
      description: 'Overhaul global architecture across whole repository',
      type: 'architecture',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-ARCH-REFACTOR',
        objective: 'Refactor core architectural abstractions',
        allowedScope: ['*'], // Unbounded scope -> triggers recommend_collaboration in preflight
        forbiddenChanges: [],
        acceptanceCriteria: ['Clean architecture', 'Zero breaking changes'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Refactor system architecture', {
      preplannedGraph: graph,
      onProgress: (m) => console.log('PROGRESS:', m),
    });

    if (result.status !== 'completed') {
      console.log('TEST 2 FAILED WITH:', result.error, JSON.stringify(result.schedulerResult, null, 2));
    }
    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(1);

    // Check preflight emitted TASK_COLLABORATION_RECOMMENDED event
    const events = eventRepo.listByRun(result.runId);
    const collabEvent = events.find((e) => e.type === 'TASK_COLLABORATION_RECOMMENDED');
    expect(collabEvent).toBeDefined();
    expect(collabEvent?.payload?.collaboration?.requestedRoles).toContain('implementer');
    expect(collabEvent?.payload?.collaboration?.requestedRoles).toContain('architecture_reviewer');

    // Check that multiple real assignments were executed
    const assignments = assignmentRepo.listByTask('TASK-ARCH-REFACTOR');
    expect(assignments.length).toBe(2);
    expect(assignments.every((a) => a.status === 'completed')).toBe(true);

    db.close();
  });
});
