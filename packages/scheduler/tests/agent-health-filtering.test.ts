import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

class ConfigurableStubAgent implements AgentAdapter {
  readonly name: string;
  calls = 0;

  constructor(
    readonly id: string,
    private readonly detected: boolean,
    private readonly failMessage?: string,
  ) {
    this.name = id;
  }

  async detect(): Promise<boolean> {
    return this.detected;
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
    this.calls += 1;
    if (this.failMessage) {
      return {
        success: false,
        message: this.failMessage,
        output: this.failMessage,
        durationMs: 5,
      };
    }
    const dir = path.join(context.worktreePath, assignment.taskId.toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.ts'), `export const by = '${this.id}';\n`, 'utf8');
    const commitHash = await new GitService(context.worktreePath).stageAndCommit(
      `feat: ${assignment.taskId}`,
      context.worktreePath,
    );
    return { success: true, message: 'done', output: 'done', durationMs: 5, commitHash };
  }
}

function makeTask(id: string): Task {
  return {
    id,
    goalId: 'goal-health',
    title: `Implement ${id}`,
    description: `Implement ${id}`,
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: `Implement ${id}`,
      allowedScope: [`${id.toLowerCase()}/**`],
      forbiddenChanges: [],
      acceptanceCriteria: [`${id} created`],
      dependencies: [],
    },
    acceptanceCriteria: [`${id} created`],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Scheduler health-aware agent filtering', () => {
  let repo: string;
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-health-sched-'));
    git = new GitService(repo);
    await git.exec(['init', '-b', 'main'], repo);
    await git.exec(['config', 'user.email', 'test@taskforge.local'], repo);
    await git.exec(['config', 'user.name', 'TaskForge Test'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n', 'utf8');
    await git.stageAndCommit('init', repo);
    worktrees = new WorktreeManager(repo, path.join(repo, '.taskforge', 'worktrees'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('never dispatches parallel tasks to an undetected agent (e.g. stopped Ollama daemon)', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const config = getDefaultConfig();
    config.execution.maxParallelTasks = 3;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.verification.preflight = false;
    config.agents = {
      codex: { enabled: true, maxParallel: 2 },
      agy: { enabled: true, maxParallel: 2 },
      ollama: { enabled: true, maxParallel: 2 },
    };

    const codex = new ConfigurableStubAgent('codex', true);
    const agy = new ConfigurableStubAgent('agy', true);
    const offlineOllama = new ConfigurableStubAgent('ollama', false, 'fetch failed');

    const registry = new AgentRegistry(false);
    registry.register(codex);
    registry.register(offlineOllama);
    registry.register(agy);

    const staticRouter: RoutingProvider = {
      id: 'static',
      async selectAgent() {
        return { agentId: 'codex', reason: 'default' };
      },
      async proposeStrategy() {
        return {
          strategy: 'single',
          complexity: 'low',
          risk: 'low',
          reasoning: 'test',
          recommendedAgents: ['codex'],
        };
      },
    };

    const graph = new TaskGraph([makeTask('T1'), makeTask('T2'), makeTask('T3')]);
    const orchestrator = new RunOrchestrator({
      repoRoot: repo,
      config,
      database: db,
      agentRegistry: registry,
      gitService: git,
      worktreeManager: worktrees,
      router: staticRouter,
    });

    const result = await orchestrator.run('Run 3 tasks without touching offline Ollama', {
      preplannedGraph: graph,
    });

    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(3);
    expect(offlineOllama.calls).toBe(0);
    expect(codex.calls + agy.calls).toBe(3);
    db.close();
  });
});
