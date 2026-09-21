import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TaskForgeDatabase,
  AssignmentRepository,
  EventRepository,
  TaskRepository,
} from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry, AgentQuotaTracker } from '@taskforge/agents';
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

  it('routes strategy "parallel" with exactly 2 roles through the concurrent investigation path, not the sequential pair handoff', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const registry = new AgentRegistry(false);

    const investigatorAgent = new FakeAgent('investigator-agent', 'Investigator Agent', [
      {
        writeFile: { path: 'notes.md', content: 'Investigation notes\n' },
        gitCommitMessage: 'docs: investigation notes',
      },
    ]);
    const implementerAgent = new FakeAgent('implementer-agent', 'Implementer Agent', [
      {
        writeFile: { path: 'feature.ts', content: 'export const feature = true;\n' },
        gitCommitMessage: 'feat: implement feature',
      },
    ]);

    registry.register(investigatorAgent);
    registry.register(implementerAgent);

    const parallelRouter: RoutingProvider = {
      id: 'mock-parallel-router',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'medium',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement fix',
            preferredAgent: 'implementer-agent',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Investigate root cause',
            preferredAgent: 'investigator-agent',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Parallel investigation required before implementation',
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
      router: parallelRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-PARALLEL-1',
      title: 'Fix flaky test',
      description: 'Investigate then implement a fix for a flaky test',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-PARALLEL-1',
        objective: 'Fix flaky test',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Test passes reliably'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Fix flaky test', { preplannedGraph: graph });

    expect(result.status).toBe('completed');

    const assignments = assignmentRepo.listByTask('TASK-PARALLEL-1');
    // The concurrent path creates: 1 investigator + 1 synthesis ('lead') + 1 implementer = 3.
    // The old bug (dispatching on selected.length === 2) would only create 2 (lead/partner handoff).
    expect(assignments.length).toBe(3);
    expect(assignments.some((a) => a.role === 'lead')).toBe(true);
    expect(assignments.some((a) => a.agentId === 'investigator-agent')).toBe(true);

    db.close();
  });

  it('runs all N agents under a "review" strategy instead of dropping everyone past the first two', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const registry = new AgentRegistry(false);

    const implementer = new FakeAgent('impl-agent', 'Implementer Agent', [
      {
        writeFile: { path: 'feature.ts', content: 'export const feature = true;\n' },
        gitCommitMessage: 'feat: implement feature',
      },
    ]);
    const reviewerA = new FakeAgent('reviewer-a', 'Reviewer A', [
      {
        writeFile: { path: 'review-a.txt', content: 'Reviewed by A.\n' },
        gitCommitMessage: 'docs: review A',
      },
    ]);
    const reviewerB = new FakeAgent('reviewer-b', 'Reviewer B', [
      {
        writeFile: { path: 'review-b.txt', content: 'Reviewed by B.\n' },
        gitCommitMessage: 'docs: review B',
      },
    ]);
    const reviewerC = new FakeAgent('reviewer-c', 'Reviewer C', [
      {
        writeFile: { path: 'review-c.txt', content: 'Reviewed by C.\n' },
        gitCommitMessage: 'docs: review C',
      },
    ]);

    registry.register(implementer);
    registry.register(reviewerA);
    registry.register(reviewerB);
    registry.register(reviewerC);

    const reviewRouter: RoutingProvider = {
      id: 'mock-review-router',
      route: async () => ({
        strategy: 'review',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'medium',
        teamSize: 4,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement the feature',
            preferredAgent: 'impl-agent',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review from angle A',
            preferredAgent: 'reviewer-a',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review from angle B',
            preferredAgent: 'reviewer-b',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review from angle C',
            preferredAgent: 'reviewer-c',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: false,
        },
        reason: 'High-risk change needs implementer plus three independent reviewers',
      }),
    };

    const config = getDefaultConfig();
    config.collaboration.maxAgentsPerTask = 4;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: reviewRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-REVIEW-N',
      title: 'Ship a high-risk change with multi-reviewer sign-off',
      description: 'Implement then get three independent reviews',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-REVIEW-N',
        objective: 'Ship the high-risk change',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Implemented', 'Reviewed by three independent reviewers'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Ship high-risk change', { preplannedGraph: graph });

    expect(result.status).toBe('completed');

    // All 4 agents must have actually run — the old bug hard-coded [lead, partner]
    // and silently dropped reviewer-b and reviewer-c.
    expect(implementer.executedAssignments.length).toBe(1);
    expect(reviewerA.executedAssignments.length).toBe(1);
    expect(reviewerB.executedAssignments.length).toBe(1);
    expect(reviewerC.executedAssignments.length).toBe(1);

    const assignments = assignmentRepo.listByTask('TASK-REVIEW-N');
    expect(assignments.length).toBe(4);
    expect(assignments.every((a) => a.status === 'completed')).toBe(true);

    db.close();
  });

  it('runs a real competitive strategy: N independent full solutions, one selected as the winner', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const registry = new AgentRegistry(false);

    const solverA = new FakeAgent('solver-a', 'Solver A', [
      {
        writeFile: { path: 'solution.ts', content: 'export const solution = "A";\n' },
        gitCommitMessage: 'feat: solution A',
      },
    ]);
    const solverB = new FakeAgent('solver-b', 'Solver B', [
      {
        writeFile: { path: 'solution.ts', content: 'export const solution = "B";\n' },
        gitCommitMessage: 'feat: solution B',
      },
    ]);
    const solverC = new FakeAgent('solver-c', 'Solver C', [
      { shouldFail: true, failMessage: 'Could not find a working approach' },
    ]);

    registry.register(solverA);
    registry.register(solverB);
    registry.register(solverC);

    const competitiveRouter: RoutingProvider = {
      id: 'mock-competitive-router',
      route: async () => ({
        strategy: 'competitive',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'high',
        teamSize: 3,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Solve it your own way',
            preferredAgent: 'solver-a',
          },
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Solve it your own way',
            preferredAgent: 'solver-b',
          },
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Solve it your own way',
            preferredAgent: 'solver-c',
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'Uncertain approach: let three agents compete',
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
      router: competitiveRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-COMPETITIVE-1',
      title: 'Find the best approach to a tricky problem',
      description: 'Let independent agents each try their own solution',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-COMPETITIVE-1',
        objective: 'Solve the tricky problem',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['A working solution exists'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Solve tricky problem competitively', {
      preplannedGraph: graph,
    });

    expect(result.status).toBe('completed');

    // All 3 agents must have actually attempted a full, independent solution —
    // the old bug ran this as parallel investigation + single implementer.
    expect(solverA.executedAssignments.length).toBe(1);
    expect(solverB.executedAssignments.length).toBe(1);
    expect(solverC.executedAssignments.length).toBe(1);

    const assignments = assignmentRepo.listByTask('TASK-COMPETITIVE-1');
    expect(assignments.length).toBe(3);
    // The failing solver's own assignment must be recorded as failed, not silently dropped.
    const failedAssignment = assignments.find((a) => a.agentId === 'solver-c');
    expect(failedAssignment?.status).toBe('failed');
    // One of the two successful solvers must have been picked as the winner.
    const completedAssignments = assignments.filter((a) => a.status === 'completed');
    expect(completedAssignments.length).toBe(2);

    db.close();
  });


  it('aborts before synthesis when an investigator fails under the default all_required policy', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const registry = new AgentRegistry(false);

    const failingInvestigator = new FakeAgent('failing-investigator', 'Failing Investigator', [
      { shouldFail: true, failMessage: 'Could not reproduce the issue' },
    ]);
    const implementerAgent = new FakeAgent('implementer-agent-2', 'Implementer Agent 2', [
      {
        writeFile: { path: 'feature.ts', content: 'export const feature = true;\n' },
        gitCommitMessage: 'feat: implement feature',
      },
    ]);

    registry.register(failingInvestigator);
    registry.register(implementerAgent);

    const parallelRouter: RoutingProvider = {
      id: 'mock-parallel-router-fail',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'high',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement fix',
            preferredAgent: 'implementer-agent-2',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Investigate root cause',
            preferredAgent: 'failing-investigator',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Parallel investigation required before implementation',
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
      router: parallelRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-PARALLEL-FAIL',
      title: 'Fix flaky test',
      description: 'Investigate then implement a fix for a flaky test',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-PARALLEL-FAIL',
        objective: 'Fix flaky test',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Test passes reliably'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Fix flaky test', {
      preplannedGraph: graph,
    });

    // Investigator failed and policy defaults to all_required: the team must
    // fail before synthesis/implementation ever runs, not silently proceed.
    expect(implementerAgent.executedAssignments.length).toBe(0);
    expect(result.tasksFailed).toBeGreaterThan(0);

    const assignments = assignmentRepo.listByTask('TASK-PARALLEL-FAIL');
    expect(assignments.some((a) => a.agentId === 'failing-investigator' && a.status === 'failed')).toBe(
      true,
    );
    // The synthesis ('lead') and implementer nodes are pre-registered by the
    // assignment graph but must never run when the investigation is aborted.
    const leadAssignment = assignments.find((a) => a.role === 'lead');
    expect(leadAssignment?.status).not.toBe('completed');

    db.close();
  });

  it('recovers a quota-exhausted investigator role by reassigning it to a distinct healthy agent', async () => {
    AgentQuotaTracker.resetInstance();
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const eventRepo = new EventRepository(db);
    const taskRepo = new TaskRepository(db);
    const registry = new AgentRegistry(false);

    const quotaInvestigator = new FakeAgent('quota-investigator', 'Quota Investigator', [
      {
        shouldFail: true,
        failMessage: 'Google Antigravity rate-limited/quota exceeded: Resets in 59h6m1s.',
        failCompletionReason: 'PROVIDER_QUOTA_EXCEEDED',
      },
    ]);
    // Registered so it exists as a healthy candidate, but never given a role
    // by the router -- only reachable through runtime role-recovery.
    const spareAgent = new FakeAgent('spare-agent', 'Spare Agent', [
      {
        writeFile: { path: 'investigation.txt', content: 'Root cause found.\n' },
        gitCommitMessage: 'docs: investigation notes',
      },
    ]);
    const implementerAgent = new FakeAgent('implementer-agent-3', 'Implementer Agent 3', [
      {
        writeFile: { path: 'feature.ts', content: 'export const feature = true;\n' },
        gitCommitMessage: 'feat: implement feature',
      },
    ]);

    registry.register(quotaInvestigator);
    registry.register(spareAgent);
    registry.register(implementerAgent);

    const parallelRouter: RoutingProvider = {
      id: 'mock-parallel-router-quota',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'high',
        teamSize: 2,
        investigationPolicy: 'all_required',
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement fix',
            preferredAgent: 'implementer-agent-3',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Investigate root cause (quota-exhausted)',
            preferredAgent: 'quota-investigator',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Parallel investigation required before implementation',
      }),
    };

    const config = getDefaultConfig();
    config.collaboration.maxAgentsPerTask = 3;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: parallelRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-PARALLEL-RECOVER',
      title: 'Fix flaky test',
      description: 'Investigate then implement a fix for a flaky test',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-PARALLEL-RECOVER',
        objective: 'Fix flaky test',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Test passes reliably'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Fix flaky test', {
      preplannedGraph: graph,
    });

    // Without recovery, 'researcher' would be the ONLY investigator and its
    // quota failure would produce zero investigation output under
    // 'all_required' -- so implementer running at all proves the role was
    // actually recovered, not just excused.
    expect(result.tasksCompleted).toBe(1);
    expect(implementerAgent.executedAssignments.length).toBe(1);
    expect(spareAgent.executedAssignments.length).toBe(1);

    // Both attempts remain persisted, each with its own assignment ID, and
    // the replacement kept the same role rather than becoming an implementer.
    const assignments = assignmentRepo.listByTask('TASK-PARALLEL-RECOVER');
    const failedOriginal = assignments.find(
      (a) => a.agentId === 'quota-investigator' && a.status === 'failed',
    );
    const replacement = assignments.find(
      (a) => a.agentId === 'spare-agent' && a.status === 'completed',
    );
    expect(failedOriginal).toBeDefined();
    expect(failedOriginal?.completionReason).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(replacement).toBeDefined();
    expect(replacement?.role).toBe('researcher');
    expect(replacement?.id).not.toBe(failedOriginal?.id);

    // A provider/capacity failure is not task rework.
    expect(taskRepo.get('TASK-PARALLEL-RECOVER')?.reworkCount).toBe(0);

    // Telemetry records the failure and the successful reassignment.
    const events = eventRepo.listByRun(result.runId);
    const failedEvent = events.find((e) => e.type === 'INVESTIGATOR_FAILED');
    const reassignedEvent = events.find((e) => e.type === 'INVESTIGATOR_REASSIGNED');
    expect(failedEvent?.payload?.role).toBe('researcher');
    expect(failedEvent?.payload?.failureReason).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(reassignedEvent?.payload?.role).toBe('researcher');
    expect(reassignedEvent?.payload?.replacementAgentId).toBe('spare-agent');

    db.close();
  });

  it('fails the investigation under all_required when a quota-exhausted role has no healthy replacement left', async () => {
    AgentQuotaTracker.resetInstance();
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const eventRepo = new EventRepository(db);
    const registry = new AgentRegistry(false);

    const quotaInvestigator = new FakeAgent('quota-investigator-2', 'Quota Investigator 2', [
      {
        shouldFail: true,
        failMessage: 'Individual quota reached. Resets in 59h6m1s.',
        failCompletionReason: 'PROVIDER_QUOTA_EXCEEDED',
      },
    ]);
    const implementerAgent = new FakeAgent('implementer-agent-4', 'Implementer Agent 4', [
      {
        writeFile: { path: 'feature.ts', content: 'export const feature = true;\n' },
        gitCommitMessage: 'feat: implement feature',
      },
    ]);

    registry.register(quotaInvestigator);
    registry.register(implementerAgent);

    const parallelRouter: RoutingProvider = {
      id: 'mock-parallel-router-quota-exhausted',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'high',
        teamSize: 2,
        investigationPolicy: 'all_required',
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement fix',
            preferredAgent: 'implementer-agent-4',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Investigate root cause',
            preferredAgent: 'quota-investigator-2',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Parallel investigation required before implementation',
      }),
    };

    const config = getDefaultConfig();
    config.collaboration.maxAgentsPerTask = 3;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: parallelRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-PARALLEL-EXHAUSTED',
      title: 'Fix flaky test',
      description: 'Investigate then implement a fix for a flaky test',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-PARALLEL-EXHAUSTED',
        objective: 'Fix flaky test',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Test passes reliably'],
      },
    };
    graph.addTask(task);

    // The only other registered agent (the implementer) is deliberately made
    // unavailable at the exact moment recovery would look for a replacement
    // -- deterministically reproducing "no healthy eligible agents remain"
    // without racing real timers or CLIs.
    const result = await orchestrator.run('Fix flaky test', {
      preplannedGraph: graph,
      onProgress: (m) => {
        if (m.includes('unavailable for researcher')) {
          AgentQuotaTracker.getInstance().setManualStatus(
            'implementer-agent-4',
            'quota_exhausted',
            'busy elsewhere',
          );
        }
      },
    });

    expect(result.status).toBe('failed');
    expect(implementerAgent.executedAssignments.length).toBe(0);

    const assignments = assignmentRepo.listByTask('TASK-PARALLEL-EXHAUSTED');
    expect(
      assignments.some((a) => a.agentId === 'quota-investigator-2' && a.status === 'failed'),
    ).toBe(true);

    const events = eventRepo.listByRun(result.runId);
    const exhaustedEvent = events.find((e) => e.type === 'INVESTIGATOR_CAPACITY_EXHAUSTED');
    expect(exhaustedEvent?.payload?.role).toBe('researcher');
    // Every eligible agent was tried exactly once for this role, then it gave up.
    expect(exhaustedEvent?.payload?.triedAgentIds).toEqual(['quota-investigator-2']);

    AgentQuotaTracker.resetInstance();
    db.close();
  });

  it('evaluates quorum on final role coverage after a successful recovery, not on the first-attempt failure', async () => {
    AgentQuotaTracker.resetInstance();
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const quotaInvestigator = new FakeAgent('quota-investigator-3', 'Quota Investigator 3', [
      { shouldFail: true, failMessage: 'quota exceeded', failCompletionReason: 'PROVIDER_QUOTA_EXCEEDED' },
    ]);
    const reproEngineer = new FakeAgent('repro-engineer', 'Repro Engineer', [
      { writeFile: { path: 'repro.txt', content: 'Reproduced.\n' }, gitCommitMessage: 'docs: repro' },
    ]);
    const archReviewer = new FakeAgent('arch-reviewer', 'Arch Reviewer', [
      { writeFile: { path: 'arch.txt', content: 'Reviewed.\n' }, gitCommitMessage: 'docs: arch review' },
    ]);
    const spareAgent = new FakeAgent('spare-agent-2', 'Spare Agent 2', [
      { writeFile: { path: 'recovered.txt', content: 'Recovered research.\n' }, gitCommitMessage: 'docs: recovered' },
    ]);
    const implementerAgent = new FakeAgent('implementer-agent-5', 'Implementer Agent 5', [
      { writeFile: { path: 'feature.ts', content: 'export const feature = true;\n' }, gitCommitMessage: 'feat: implement' },
    ]);

    registry.register(quotaInvestigator);
    registry.register(reproEngineer);
    registry.register(archReviewer);
    registry.register(spareAgent);
    registry.register(implementerAgent);

    const parallelRouter: RoutingProvider = {
      id: 'mock-parallel-router-quorum',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'high',
        teamSize: 4,
        investigationPolicy: 'quorum',
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement fix',
            preferredAgent: 'implementer-agent-5',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Investigate root cause',
            preferredAgent: 'quota-investigator-3',
          },
          {
            role: 'reproduction_engineer',
            requiredCapabilities: ['canRead'],
            objective: 'Reproduce the bug',
            preferredAgent: 'repro-engineer',
          },
          {
            role: 'architecture_reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review architecture impact',
            preferredAgent: 'arch-reviewer',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Parallel investigation with quorum policy',
      }),
    };

    const config = getDefaultConfig();
    config.collaboration.maxAgentsPerTask = 4;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: parallelRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-QUORUM-RECOVER',
      title: 'Fix flaky test',
      description: 'Investigate then implement a fix for a flaky test',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-QUORUM-RECOVER',
        objective: 'Fix flaky test',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Test passes reliably'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Fix flaky test', { preplannedGraph: graph });

    // All 3 investigator roles end up satisfied (researcher via recovery) --
    // quorum sees 0/3 unsatisfied, not the raw "1 attempt failed" signal.
    expect(result.tasksCompleted).toBe(1);
    expect(implementerAgent.executedAssignments.length).toBe(1);

    db.close();
    AgentQuotaTracker.resetInstance();
  });
});
