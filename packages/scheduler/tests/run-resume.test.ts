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
import { RunRepository, TaskForgeDatabase } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

class FlakyDownstreamAgent implements AgentAdapter {
  readonly id = 'flaky-downstream';
  readonly name = 'Flaky Downstream Agent';
  public failDownstream = true;
  public calls: string[] = [];

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['file_editor', 'git'],
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls.push(assignment.taskId);
    const git = new GitService(context.worktreePath);

    if (assignment.taskId === 'TASK-UPSTREAM') {
      fs.writeFileSync(path.join(context.worktreePath, 'upstream.ts'), 'export const a = 1;\n', 'utf8');
      const commitHash = await git.stageAndCommit('feat: upstream', context.worktreePath);
      return {
        success: true,
        message: 'done',
        output: 'Created upstream.ts',
        durationMs: 1,
        commitHash,
      };
    }

    if (this.failDownstream) {
      return { success: false, message: 'simulated interruption', durationMs: 1 };
    }

    const sawUpstream = fs.existsSync(path.join(context.worktreePath, 'upstream.ts'));
    if (!sawUpstream) {
      return { success: false, message: 'upstream.ts missing', durationMs: 1 };
    }
    fs.writeFileSync(path.join(context.worktreePath, 'downstream.ts'), 'export const b = 2;\n', 'utf8');
    const commitHash = await git.stageAndCommit('feat: downstream', context.worktreePath);
    return {
      success: true,
      message: 'done',
      output: 'Created downstream.ts',
      durationMs: 1,
      commitHash,
    };
  }
}

function makeTask(id: string, dependencies: string[]): Task {
  return {
    id,
    goalId: 'goal-resume',
    title: id,
    description: id,
    type: 'implementation',
    status: 'accepted',
    dependencies,
    contract: {
      objective: `Implement ${id}`,
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: [`${id} done`],
      dependencies,
    },
    acceptanceCriteria: [`${id} done`],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RunOrchestrator.resume', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-resume');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
    fs.mkdirSync(testRepoRoot, { recursive: true });
    gitService = new GitService(testRepoRoot);
    await gitService.exec(['init', '-b', 'main'], testRepoRoot);
    await gitService.exec(['config', 'user.name', 'TaskForge Resume Test'], testRepoRoot);
    await gitService.exec(['config', 'user.email', 'resume@taskforge.dev'], testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# resume test\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
  });

  function build(agent: FlakyDownstreamAgent, db: TaskForgeDatabase) {
    const registry = new AgentRegistry(false);
    registry.register(agent);
    const router: RoutingProvider = {
      id: 'resume-test-router',
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
            preferredAgent: agent.id,
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'Deterministic resume test',
      }),
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    return new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService,
      worktreeManager,
    });
  }

  it('keeps integrated tasks and re-executes only the pending ones', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const agent = new FlakyDownstreamAgent();
    const orchestrator = build(agent, db);

    const graph = new TaskGraph();
    graph.addTask(makeTask('TASK-UPSTREAM', []));
    graph.addTask(makeTask('TASK-DOWNSTREAM', ['TASK-UPSTREAM']));

    const first = await orchestrator.run('Build upstream then downstream.', {
      preplannedGraph: graph,
    });
    expect(first.status).toBe('failed');
    expect(first.tasksCompleted).toBe(1);
    const upstreamCallsBefore = agent.calls.filter((c) => c === 'TASK-UPSTREAM').length;
    expect(upstreamCallsBefore).toBe(1);

    agent.failDownstream = false;
    agent.calls = [];
    const resumed = await orchestrator.resume(first.runId);

    expect(resumed.status).toBe('completed');
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.tasksCompleted).toBe(2);
    expect(agent.calls).not.toContain('TASK-UPSTREAM');
    expect(agent.calls).toContain('TASK-DOWNSTREAM');

    const files = await gitService.exec(
      ['ls-tree', '-r', '--name-only', resumed.integrationBranch!],
      testRepoRoot,
    );
    expect(files).toContain('upstream.ts');
    expect(files).toContain('downstream.ts');

    db.close();
  });

  it('repeats only the final check when every task is integrated but the run did not complete', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const agent = new FlakyDownstreamAgent();
    const orchestrator = build(agent, db);
    const graph = new TaskGraph();
    graph.addTask(makeTask('TASK-UPSTREAM', []));
    const first = await orchestrator.run('Build upstream.', { preplannedGraph: graph });
    expect(first.status).toBe('completed');

    // What a failed final check leaves behind: tasks integrated, run marked failed.
    new RunRepository(db).updateStatus(first.runId, 'failed');
    agent.calls = [];

    expect(await orchestrator.checkResumable(first.runId)).toBeUndefined();
    const resumed = await orchestrator.resume(first.runId);

    expect(resumed.status).toBe('completed');
    expect(resumed.tasksCompleted).toBe(1);
    expect(resumed.integrationBranch).toBeDefined();
    expect(agent.calls).toEqual([]); // no agent was called
    db.close();
  });

  it('rejects resuming a completed run and an unknown run', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const agent = new FlakyDownstreamAgent();
    agent.failDownstream = false;
    const orchestrator = build(agent, db);

    const graph = new TaskGraph();
    graph.addTask(makeTask('TASK-UPSTREAM', []));
    const done = await orchestrator.run('Build upstream.', { preplannedGraph: graph });
    expect(done.status).toBe('completed');

    await expect(orchestrator.resume(done.runId)).rejects.toThrow(/already completed/);
    await expect(orchestrator.resume('run-missing')).rejects.toThrow(/not found/);

    db.close();
  });
});
