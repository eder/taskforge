import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { getDefaultConfig } from '@taskforge/shared';

describe('runtime mutation guard for read-only tasks', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-mutation-guard');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Mutation Guard Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'mutation-guard@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Mutation Guard Test\n', 'utf8');
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

  it('discards a mutation an agent produced despite a read-only task policy, and never integrates it', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const registry = new AgentRegistry(false);

    // Simulates an agent that ignores the read-only policy and writes +
    // commits anyway (FakeAgent has no self-enforcement -- this is exactly
    // why the guard must live in the runtime chokepoint, not per-adapter).
    const misbehavingAgent = new FakeAgent('misbehaving-agent', 'Misbehaving Agent', [
      {
        writeFile: { path: 'unauthorized-change.txt', content: 'should never land\n' },
        gitCommitMessage: 'feat: unauthorized change',
      },
    ]);
    registry.register(misbehavingAgent);

    const singleAgentRouter: RoutingProvider = {
      id: 'mock-single-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Analyze the repository',
            preferredAgent: 'misbehaving-agent',
          },
        ],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
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
      router: singleAgentRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-READONLY',
      title: 'Analyze the repository architecture',
      description: 'Analyze the repository architecture, do not modify anything',
      type: 'investigation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-READONLY',
        objective: 'Produce an architecture analysis report',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Substantive analysis report'],
      },
    };
    graph.addTask(task);

    const baseCommit = await gitService.getHeadCommit();
    const result = await orchestrator.run('Analyze the repository, do not modify anything', {
      preplannedGraph: graph,
    });

    expect(result.status).toBe('completed');

    // The main repository must never have received the rogue commit.
    const headAfter = await gitService.getHeadCommit();
    expect(headAfter).toBe(baseCommit);
    // Ignore .taskforge/ (execution logs / run state) -- that is expected
    // framework bookkeeping, not a task-caused repository mutation. The
    // actual invariant is that the agent's write never landed anywhere.
    const status = await gitService.getStatus(testRepoRoot);
    const nonFrameworkChanges = status.uncommittedFiles.filter((f) => !f.includes('.taskforge/'));
    expect(nonFrameworkChanges).toEqual([]);
    expect(fs.existsSync(path.join(testRepoRoot, 'unauthorized-change.txt'))).toBe(false);
    expect(result.integrationBranch).toBeUndefined();

    const events = eventRepo.listByTask('TASK-READONLY');
    expect(events.some((e) => e.type === 'MUTATION_BLOCKED')).toBe(true);

    db.close();
  });
});
