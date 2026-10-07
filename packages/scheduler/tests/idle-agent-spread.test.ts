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
    this.seen.active += 1;
    this.seen.peak = Math.max(this.seen.peak, this.seen.active);
    this.seen.agentsUsed.add(this.id);
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const dir = path.join(context.worktreePath, assignment.taskId.toLowerCase());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'file.ts'), `export const owner = '${this.id}';\n`, 'utf8');
      const commitHash = await new GitService(context.worktreePath).stageAndCommit(
        `feat: ${assignment.taskId}`,
        context.worktreePath,
      );
      return { success: true, message: 'done', output: 'done', durationMs: 400, commitHash };
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
    const seen = new Concurrency();
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
});
