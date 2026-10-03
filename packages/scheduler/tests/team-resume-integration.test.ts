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

class Researcher implements AgentAdapter {
  readonly id = 'res';
  readonly name = 'Researcher';
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: false, canExecute: false, languages: [], tools: [] };
  }
  async execute(): Promise<AgentResult> {
    return { success: true, message: 'Studied the area.', durationMs: 1 };
  }
}

/** First pass writes the feature; the pass that continues from kept work also writes ok.flag. */
class Implementer implements AgentAdapter {
  readonly id = 'impl';
  readonly name = 'Implementer';
  calls = 0;
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(_a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    fs.writeFileSync(path.join(context.worktreePath, 'feature.txt'), `draft ${this.calls}\n`);
    if (this.calls > 1) fs.writeFileSync(path.join(context.worktreePath, 'ok.flag'), 'ok\n');
    const git = new GitService(context.worktreePath);
    const commitHash = await git.stageAndCommit(`pass ${this.calls}`, context.worktreePath);
    return { success: true, message: `pass ${this.calls}`, durationMs: 1, commitHash };
  }
}

class Reviewer implements AgentAdapter {
  readonly id = 'rev';
  readonly name = 'Reviewer';
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: false, canExecute: false, languages: [], tools: [] };
  }
  async execute(): Promise<AgentResult> {
    const reply = 'Fine.\nREVIEW_VERDICT: APPROVED';
    return { success: true, message: reply, output: reply, durationMs: 1 };
  }
}

function task(): Task {
  return {
    id: 'TASK-1',
    goalId: 'g',
    title: 'Add the feature',
    description: 'Add the feature',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Add feature.txt',
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['feature.txt exists'],
      dependencies: [],
      completionMode: 'mutation',
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Fails like a test does until the agents have produced ok.flag.
const CHECK = `node -e "if(!require('fs').existsSync('ok.flag')){console.error('AssertionError: ok.flag is missing');process.exit(1)}"`;

describe('a team that continues from kept work must integrate cleanly', () => {
  const root = path.resolve(__dirname, '../test-sandbox-team-resume');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'T'], root);
    await git.exec(['config', 'user.email', 't@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
    await git.stageAndCommit('Initial commit', root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  });
  afterEach(async () => {
    await worktrees.prune().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('delivers the whole result, not just the difference from the kept commit', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const implementer = new Implementer();
    const registry = new AgentRegistry(false);
    registry.register(new Researcher());
    registry.register(implementer);
    registry.register(new Reviewer());
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'collaborative',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'high',
        teamSize: 3,
        roles: [
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'Study', preferredAgent: 'res' },
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Implement', preferredAgent: 'impl' },
          { role: 'architecture_reviewer', requiredCapabilities: ['canRead'], objective: 'Review', preferredAgent: 'rev' },
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
    config.verification.commands = [CHECK];
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });

    const first = await orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([task()]) });
    expect(first.status).toBe('failed'); // the check needs ok.flag, which the first pass did not write

    const resumed = await orchestrator.resume(first.runId, { guidance: 'make the check pass' });

    expect(resumed.error ?? '').not.toContain('cherry-pick');
    expect(resumed.status).toBe('completed');
    const feature = await git.exec(['show', `${resumed.integrationBranch}:feature.txt`], root);
    const flag = await git.exec(['show', `${resumed.integrationBranch}:ok.flag`], root);
    expect(feature.trim()).toBe('draft 2');
    expect(flag.trim()).toBe('ok');
    db.close();
  }, 120_000);
});

describe('an integration conflict keeps the work instead of ending the run with a git error', () => {
  const root = path.resolve(__dirname, '../test-sandbox-integration-conflict');
  let git: GitService;
  let worktrees: WorktreeManager;

  class Overwriter implements AgentAdapter {
    readonly id = 'over';
    readonly name = 'Overwriter';
    async detect() {
      return true;
    }
    async capabilities(): Promise<AgentCapabilities> {
      return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
    }
    async execute(a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
      // Both tasks rewrite the same file from the same starting point.
      fs.writeFileSync(path.join(context.worktreePath, 'README.md'), `# written by ${a.taskId}\n`);
      const git = new GitService(context.worktreePath);
      const commitHash = await git.stageAndCommit(`edit by ${a.taskId}`, context.worktreePath);
      return { success: true, message: 'edited', durationMs: 1, commitHash };
    }
  }

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'T'], root);
    await git.exec(['config', 'user.email', 't@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
    await git.stageAndCommit('Initial commit', root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  });
  afterEach(async () => {
    await worktrees.prune().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('blocks the task that conflicts, keeps its work, and reports it in words', async () => {
    const { describeRunFailures, formatRunFailureLines } = await import('../src/run-failure-report.js');
    const { TaskRepository, EventRepository } = await import('@taskforge/persistence');
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(new Overwriter());
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'x', preferredAgent: 'over' }],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'test',
      }),
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.verification.maxReworkCycles = 0; // do not retry: look at the first outcome
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    const a = { ...task(), id: 'TASK-A', title: 'Edit A' };
    const b = { ...task(), id: 'TASK-B', title: 'Edit B' };

    const result = await orchestrator.run('Edit the readme twice', { preplannedGraph: new TaskGraph([a, b]) });

    expect(result.status).toBe('failed');
    expect(result.error ?? '').not.toContain('cherry-pick');
    const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) }, result.runId);
    const text = formatRunFailureLines(lines, result.runId).join('\n');
    expect(text).toContain('conflicts with changes already on the run branch');
    expect(lines.some((l) => l.keptBranch)).toBe(true); // nothing was lost
    expect(result.tasksCompleted).toBe(1);
    db.close();
  }, 120_000);
});
