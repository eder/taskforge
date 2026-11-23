import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type AgentAssignment,
  type AgentCapabilities,
  type AgentContext,
  type AgentResult,
  getDefaultConfig,
} from '@taskforge/shared';
import { type AgentAdapter, AgentRegistry } from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

/** Shared by all agents so the test can see how many ran at the same moment. */
class Concurrency {
  active = 0;
  peak = 0;
  readonly agentsUsed = new Set<string>();
  private releaseBarrier?: () => void;
  readonly barrier: Promise<void>;

  constructor(readonly waitForConcurrentCount: number) {
    this.barrier =
      waitForConcurrentCount <= 1
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.releaseBarrier = resolve;
            setTimeout(resolve, 1500);
          });
  }

  enter(agentId: string): void {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    this.agentsUsed.add(agentId);
    if (this.active >= this.waitForConcurrentCount) {
      this.releaseBarrier?.();
    }
  }
}

class SlowWritingAgent implements AgentAdapter {
  readonly name: string;
  constructor(
    readonly id: string,
    private readonly seen: Concurrency,
  ) {
    this.name = id;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['git'],
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.seen.enter(this.id);
    try {
      await this.seen.barrier;
      const dir = path.join(context.worktreePath, assignment.taskId.toLowerCase());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'file.ts'), `export const owner = '${this.id}';\n`, 'utf8');
      const commitHash = await new GitService(context.worktreePath).stageAndCommit(
        `feat: ${assignment.taskId}`,
        context.worktreePath,
      );
      return { success: true, message: 'done', output: 'done', durationMs: 10, commitHash };
    } finally {
      this.seen.active -= 1;
    }
  }
}

function independentTask(id: string): Task {
  const scope = [`${id.toLowerCase()}/**`];
  return {
    id,
    goalId: 'goal-spread',
    title: `Change ${id}`,
    description: `Change ${id}`,
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: `Change ${id}`,
      allowedScope: scope,
      forbiddenChanges: [],
      acceptanceCriteria: [`${id} changed`],
      dependencies: [],
    },
    acceptanceCriteria: [`${id} changed`],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('independent tasks use every idle agent', () => {
  const repo = path.resolve(__dirname, '../test-sandbox-idle-spread');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(repo, { recursive: true });
    git = new GitService(repo);
    await git.exec(['init', '-b', 'main'], repo);
    await git.exec(['config', 'user.name', 'T'], repo);
    await git.exec(['config', 'user.email', 't@taskforge.dev'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# spread\n', 'utf8');
    await git.stageAndCommit('Initial commit', repo);
    worktrees = new WorktreeManager(repo, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function setup(onlyWriter?: string) {
    const seen = new Concurrency(onlyWriter ? 1 : 3);
    const registry = new AgentRegistry(false);
    for (const id of ['alpha', 'beta', 'gamma']) registry.register(new SlowWritingAgent(id, seen));

    // The router prefers the same agent for every task, as it does when one agent is the best fit.
    const router: RoutingProvider = {
      id: 'same-preference-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'medium',
        risk: 'medium',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canRead', 'canWrite'],
            objective: 'Implement the assigned change',
            preferredAgent: 'alpha',
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'every task prefers alpha',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.execution.maxParallelTasks = 3;
    if (onlyWriter) config.ownership = { rules: [{ scope: '*', writers: [onlyWriter] }] };

    const graph = new TaskGraph();
    for (const id of ['TASK-A', 'TASK-B', 'TASK-C']) graph.addTask(independentTask(id));

    const db = new TaskForgeDatabase(':memory:');
    const orchestrator = new RunOrchestrator({
      repoRoot: repo,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    return {
      seen,
      db,
      run: () => orchestrator.run('Change three separate areas.', { preplannedGraph: graph }),
    };
  }

  it('runs three independent tasks at the same time on three agents, not one after another on the preferred one', async () => {
    const { seen, db, run } = setup();
    const result = await run();

    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(3);
    expect(seen.peak).toBe(3);
    expect(seen.agentsUsed.size).toBe(3);
    db.close();
  }, 30_000);

  it('never uses an agent the ownership policy does not allow to write, even if it is idle', async () => {
    const { seen, db, run } = setup('beta');
    const result = await run();

    expect(result.status).toBe('completed');
    expect([...seen.agentsUsed]).toEqual(['beta']);
    expect(seen.peak).toBe(1);
    db.close();
  }, 30_000);

  it('spreads across completely idle agents before stacking a 2nd task onto an agent with maxParallel > 1', async () => {
    const seen = new Concurrency(3);
    const registry = new AgentRegistry(false);
    registry.register(new SlowWritingAgent('alpha', seen));
    registry.register(new SlowWritingAgent('beta', seen));

    const router: RoutingProvider = {
      id: 'same-preference-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'medium',
        risk: 'medium',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canRead', 'canWrite'],
            objective: 'Implement',
            preferredAgent: 'alpha',
          },
        ],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'prefers alpha',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.execution.maxParallelTasks = 3;
    config.agents = {
      alpha: { enabled: true, maxParallel: 2 },
      beta: { enabled: true, maxParallel: 1 },
    };

    const graph = new TaskGraph();
    for (const id of ['TASK-1', 'TASK-2', 'TASK-3']) graph.addTask(independentTask(id));

    const db = new TaskForgeDatabase(':memory:');
    const orchestrator = new RunOrchestrator({
      repoRoot: repo,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    const result = await orchestrator.run('Three independent changes', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(3);
    // Both alpha (2 slots) and beta (1 slot) run simultaneously -> peak 3, both providers used!
    expect(seen.agentsUsed.size).toBe(2);
    expect(seen.peak).toBe(3);
    db.close();
  }, 30_000);

  it('does not falsely blame a parallel sibling task for files integrated by another sibling after a shared dependency', async () => {
    // Reproduces the exact zaira TASK-53/TASK-54 race: both depend on read-only TASK-52,
    // start in parallel at the same commit, TASK-54 integrates first, then TASK-53 finishes.
    let task54Integrated!: () => void;
    const waitForTask54 = new Promise<void>((resolve) => {
      task54Integrated = resolve;
    });

    const makeAgent = (id: string): AgentAdapter => ({
      id,
      name: id,
      detect: async () => true,
      capabilities: async () => ({
        canRead: true,
        canWrite: true,
        canExecute: false,
        languages: ['TypeScript'],
        tools: ['file_editor'],
      }),
      execute: async (assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> => {
        if (assignment.taskId === 'TASK-52') {
          return { success: true, output: 'Architecture analysis report.', durationMs: 5 };
        }
        if (assignment.taskId === 'TASK-54') {
          fs.writeFileSync(path.join(context.worktreePath, 'TASK-54.txt'), 'memory fix\n', 'utf8');
          const wtGit = new GitService(context.worktreePath);
          await wtGit.stageAndCommit('TASK-54 memory fix', context.worktreePath);
          const commitHash = await wtGit.getHeadCommit(context.worktreePath);
          setTimeout(() => task54Integrated(), 150);
          return { success: true, commitHash, message: 'done', durationMs: 5 };
        }
        // TASK-53 waits until TASK-54 has finished and integrated onto the run branch.
        await waitForTask54;
        fs.writeFileSync(path.join(context.worktreePath, 'TASK-53.txt'), 'retrieval fix\n', 'utf8');
        const wtGit = new GitService(context.worktreePath);
        await wtGit.stageAndCommit('TASK-53 retrieval fix', context.worktreePath);
        const commitHash = await wtGit.getHeadCommit(context.worktreePath);
        return { success: true, commitHash, message: 'done', durationMs: 5 };
      },
    });

    const registry = new AgentRegistry(false);
    registry.register(makeAgent('alpha'));
    registry.register(makeAgent('beta'));

    const router: RoutingProvider = {
      id: 'parallel-router',
      route: async ({ task }) => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: task.type === 'architecture' ? 'researcher' : 'implementer',
            requiredCapabilities: task.type === 'architecture' ? ['canRead'] : ['canRead', 'canWrite'],
            objective: task.title,
            preferredAgent: task.id === 'TASK-54' ? 'beta' : 'alpha',
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
    config.verification.review = false;
    config.verification.enforceScope = true;
    config.execution.maxParallelTasks = 3;

    const now = new Date();
    const graph = new TaskGraph([
      {
        id: 'TASK-52',
        goalId: 'g-race',
        title: 'Architecture Review',
        description: 'Review',
        type: 'architecture',
        status: 'accepted',
        dependencies: [],
        contract: {
          objective: 'Review architecture',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['Report produced'],
          dependencies: [],
          completionMode: 'report',
        },
        acceptanceCriteria: ['Report produced'],
        reworkCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        ...independentTask('TASK-53'),
        dependencies: ['TASK-52'],
        contract: {
          ...independentTask('TASK-53').contract,
          allowedScope: ['TASK-53.txt'],
          dependencies: ['TASK-52'],
        },
      },
      {
        ...independentTask('TASK-54'),
        dependencies: ['TASK-52'],
        contract: {
          ...independentTask('TASK-54').contract,
          allowedScope: ['TASK-54.txt'],
          dependencies: ['TASK-52'],
        },
      },
    ]);

    const db = new TaskForgeDatabase(':memory:');
    const orchestrator = new RunOrchestrator({
      repoRoot: repo,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    const result = await orchestrator.run('Fix retrieval and memory in parallel', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(3);
    expect(result.tasksFailed).toBe(0);
    db.close();
  }, 30_000);
});
