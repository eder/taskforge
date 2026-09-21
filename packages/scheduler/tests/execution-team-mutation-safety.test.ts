import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskForgeDatabase, AssignmentRepository, EventRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { getDefaultConfig } from '@taskforge/shared';

describe('execution-team: no implicit implementer promotion, investigation stays read-only', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-mutation-safety');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Mutation Safety Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'mutation-safety@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Mutation Safety Test\n', 'utf8');
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

  it('rejects an implementation task routed via "parallel" strategy with no implementer role, instead of promoting selected[0]', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const registry = new AgentRegistry(false);

    const reproAgent = new FakeAgent('repro-agent', 'Repro Agent', [
      { writeFile: { path: 'repro.md', content: 'repro notes\n' }, gitCommitMessage: 'docs: repro' },
    ]);
    const researchAgent = new FakeAgent('research-agent', 'Research Agent', [
      { activitySteps: ['Researching'] },
    ]);

    registry.register(reproAgent);
    registry.register(researchAgent);

    // No 'implementer' role at all -- mirrors StaticRoutingProvider's real
    // investigation team shape, but the task itself requires a code change.
    const noImplementerRouter: RoutingProvider = {
      id: 'mock-no-implementer-router',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 2,
        roles: [
          {
            role: 'reproduction_engineer',
            requiredCapabilities: ['canWrite'],
            objective: 'Reproduce the bug',
            preferredAgent: 'repro-agent',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Trace root cause',
            preferredAgent: 'research-agent',
          },
        ],
        communication: { required: true, initialAlignment: true, synthesisBeforeImplementation: true },
        reason: 'test',
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
      router: noImplementerRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-NO-IMPL',
      title: 'Fix the flaky retry logic',
      description: 'The retry logic has a race condition that must be fixed',
      type: 'implementation', // requires code_change_required -- an implementer MUST be staffed
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-NO-IMPL',
        objective: 'Fix the race condition in retry logic',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Race condition is fixed'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Fix the flaky retry logic', { preplannedGraph: graph });

    // Must fail explicitly, never silently succeed via a promoted investigator.
    expect(result.status).toBe('failed');

    const events = eventRepo.listByTask('TASK-NO-IMPL');
    expect(events.some((e) => e.type === 'ROUTING_INVALID_FOR_TASK')).toBe(true);

    db.close();
  });

  it('never executes a mutating implementer step for a pure investigation task, even under "parallel" strategy', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const registry = new AgentRegistry(false);

    const reproAgent = new FakeAgent('repro-agent', 'Repro Agent', [
      { activitySteps: ['Reproducing the issue'] },
    ]);
    const researchAgent = new FakeAgent('research-agent', 'Research Agent', [
      { activitySteps: ['Tracing the data flow'] },
    ]);
    const reviewAgent = new FakeAgent('review-agent', 'Review Agent', [
      { activitySteps: ['Reviewing architecture invariants'] },
    ]);

    registry.register(reproAgent);
    registry.register(researchAgent);
    registry.register(reviewAgent);

    const investigationRouter: RoutingProvider = {
      id: 'mock-investigation-router',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 3,
        roles: [
          {
            role: 'reproduction_engineer',
            requiredCapabilities: ['canWrite'],
            objective: 'Reproduce problem',
            preferredAgent: 'repro-agent',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Trace flow',
            preferredAgent: 'research-agent',
          },
          {
            role: 'architecture_reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Recommend architecture fix',
            preferredAgent: 'review-agent',
          },
        ],
        communication: { required: true, initialAlignment: true, synthesisBeforeImplementation: true },
        reason: 'test',
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
      router: investigationRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-INVESTIGATE',
      title: 'Investigate the flaky test',
      description: 'Investigate why the integration test is flaky',
      type: 'investigation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-INVESTIGATE',
        objective: 'Find the root cause of the flaky test',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Root cause identified'],
      },
    };
    graph.addTask(task);

    const baseCommit = await gitService.getHeadCommit();
    const result = await orchestrator.run('Investigate the flaky test', { preplannedGraph: graph });

    expect(result.status).toBe('completed');

    // No mutating implementer assignment should ever have executed: none of
    // the persisted assignments for this task may be 'completed' with a
    // commit hash beyond baseCommit, and the repo must be untouched.
    const assignments = assignmentRepo.listByTask('TASK-INVESTIGATE');
    expect(assignments.length).toBeGreaterThan(0);

    const headAfter = await gitService.getHeadCommit();
    expect(headAfter).toBe(baseCommit);

    // Ignore .taskforge/ (execution logs / run state) -- expected framework
    // bookkeeping, not a task-caused repository mutation.
    const status = await gitService.getStatus(testRepoRoot);
    const nonFrameworkChanges = status.uncommittedFiles.filter((f) => !f.includes('.taskforge/'));
    expect(nonFrameworkChanges).toEqual([]);

    // The task's own output must be a synthesized investigation report, not empty.
    expect(result.taskOutputs?.['TASK-INVESTIGATE']).toBeTruthy();

    db.close();
  });
});
