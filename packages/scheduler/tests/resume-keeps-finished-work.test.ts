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
import { TaskForgeDatabase, RunRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

const REPORT = '## Analysis\n\n' + 'The repository was inspected in detail and the findings are recorded here. '.repeat(6);

class ScriptedAgent implements AgentAdapter {
  readonly id = 'scripted';
  readonly name = 'Scripted';
  public calls: string[] = [];
  public failTaskB = true;

  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls.push(assignment.taskId);
    if (assignment.taskId === 'TASK-B' && this.failTaskB) {
      return { success: false, message: 'simulated failure', durationMs: 1 };
    }
    if (assignment.taskId === 'TASK-WRITE') {
      const git = new GitService(context.worktreePath);
      fs.writeFileSync(path.join(context.worktreePath, 'written.txt'), 'x\n');
      const commitHash = await git.stageAndCommit('feat: write', context.worktreePath);
      return { success: true, message: 'ok', output: 'wrote written.txt', durationMs: 1, commitHash };
    }
    return { success: true, message: 'ok', output: REPORT, durationMs: 1 };
  }
}

function reportTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    goalId: 'goal-report',
    title: `Report ${id}`,
    description: `Read-only ${id}`,
    type: 'investigation',
    status: 'accepted',
    dependencies,
    contract: {
      objective: `Analyse ${id}`,
      allowedScope: [],
      forbiddenChanges: ['*'],
      acceptanceCriteria: ['report produced'],
      dependencies,
      completionMode: 'report',
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function writeTask(id: string): Task {
  return {
    ...reportTask(id),
    type: 'implementation',
    contract: {
      objective: 'Write a file',
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['file written'],
      dependencies: [],
      completionMode: 'mutation',
    },
  };
}

describe('tf resume keeps finished work', () => {
  const root = path.resolve(__dirname, '../test-sandbox-resume-reports');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'Resume Reports'], root);
    await git.exec(['config', 'user.email', 'resume@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# resume\n');
    await git.stageAndCommit('Initial commit', root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  function orchestrate(agent: ScriptedAgent, db: TaskForgeDatabase) {
    const registry = new AgentRegistry(false);
    registry.register(agent);
    const router: RoutingProvider = {
      id: 'r',
      route: async (input) => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: input.task.type === 'implementation' ? 'implementer' : 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'x',
            preferredAgent: 'scripted',
          },
        ],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'deterministic',
      }),
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    return new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
  }

  it('does not redo a finished read-only report task when no run branch exists', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const agent = new ScriptedAgent();
    const orchestrator = orchestrate(agent, db);

    const first = await orchestrator.run('analyse then conclude', {
      preplannedGraph: new TaskGraph([reportTask('TASK-A'), reportTask('TASK-B', ['TASK-A'])]),
    });
    expect(first.status).toBe('failed');
    // Report-only runs integrate nothing, so the run branch never exists.
    expect(await git.branchExists(`taskforge/${first.runId}`)).toBe(false);
    expect(agent.calls).toContain('TASK-A');

    agent.failTaskB = false;
    agent.calls = [];
    const progress: string[] = [];
    const resumed = await orchestrator.resume(first.runId, { onProgress: (m) => progress.push(m) });

    expect(resumed.status).toBe('completed');
    expect(agent.calls).toEqual(['TASK-B']); // TASK-A was not repeated
    expect(progress.join('\n')).toContain('1 task(s) already integrated (TASK-A)');
    db.close();
  });

  it('keeps the earlier report output available to the dependent task after resume', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const agent = new ScriptedAgent();
    const orchestrator = orchestrate(agent, db);
    const first = await orchestrator.run('analyse then conclude', {
      preplannedGraph: new TaskGraph([reportTask('TASK-A'), reportTask('TASK-B', ['TASK-A'])]),
    });
    agent.failTaskB = false;
    await orchestrator.resume(first.runId);
    const metadata = JSON.parse(new RunRepository(db).get(first.runId)!.metadataJson!);
    expect(Object.keys(metadata.taskOutputs)).toContain('TASK-A');
    db.close();
  });

  it('still redoes a task whose commit was on a run branch that no longer exists', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const agent = new ScriptedAgent();
    const orchestrator = orchestrate(agent, db);
    const first = await orchestrator.run('write then report', {
      preplannedGraph: new TaskGraph([writeTask('TASK-WRITE'), reportTask('TASK-B', ['TASK-WRITE'])]),
    });
    expect(first.status).toBe('failed');
    const runBranch = `taskforge/${first.runId}`;
    expect(await git.branchExists(runBranch)).toBe(true);
    await git.exec(['branch', '-D', runBranch], root); // e.g. /clean

    agent.failTaskB = false;
    agent.calls = [];
    const resumed = await orchestrator.resume(first.runId);

    expect(resumed.status).toBe('completed');
    expect(agent.calls).toContain('TASK-WRITE'); // its work was lost, so it ran again
    db.close();
  });
});
