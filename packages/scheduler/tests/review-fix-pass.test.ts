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
import { reviewChangesFrom, REVIEW_CONTRACT, reviewFixObjective } from '../src/review-verdict.js';

class Researcher implements AgentAdapter {
  readonly id = 'res';
  readonly name = 'Researcher';
  objectives: string[] = [];
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: false, canExecute: false, languages: [], tools: [] };
  }
  async execute(a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.objectives.push(context.task.objective);
    return { success: true, message: 'Studied the area. The change belongs in feature.txt.', durationMs: 1 };
  }
}

/** Writes feature.txt; on a fix pass it also records that it saw the reviewer's findings. */
class Implementer implements AgentAdapter {
  readonly id = 'impl';
  readonly name = 'Implementer';
  objectives: string[] = [];
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(_a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.objectives.push(context.assignment.objective);
    const fixing = this.objectives.length > 1;
    fs.writeFileSync(path.join(context.worktreePath, 'feature.txt'), fixing ? 'fixed\n' : 'first draft\n');
    const git = new GitService(context.worktreePath);
    const commitHash = await git.stageAndCommit(fixing ? 'fix: review findings' : 'feat: feature', context.worktreePath);
    return { success: true, message: fixing ? 'Addressed the findings' : 'Wrote the feature', durationMs: 1, commitHash };
  }
}

class Reviewer implements AgentAdapter {
  readonly id = 'rev';
  readonly name = 'Reviewer';
  calls = 0;
  objectives: string[] = [];
  /** What the task contract says, which is where a handed-over previous output arrives. */
  taskObjectives: string[] = [];
  constructor(private reply: string) {}
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: false, canExecute: false, languages: [], tools: [] };
  }
  async execute(a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    this.objectives.push(a.objective);
    this.taskObjectives.push(context.task.objective);
    return { success: true, message: this.reply, output: this.reply, durationMs: 1 };
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

describe('review verdict parsing', () => {
  it('reads the rejection and the listed changes, ignores approvals and replies without a verdict', () => {
    const rejected = reviewChangesFrom(
      'I read the diff.\n- PENDING breaks old readers\n- past valid_until expires the row\n\nREVIEW_VERDICT: REJECTED',
    );
    expect(rejected.rejected).toBe(true);
    expect(rejected.changes).toEqual(['PENDING breaks old readers', 'past valid_until expires the row']);
    expect(reviewChangesFrom('Looks good.\nREVIEW_VERDICT: APPROVED').rejected).toBe(false);
    expect(reviewChangesFrom('I would not accept this yet, items 1-3 must be fixed.').rejected).toBe(false);
    expect(reviewChangesFrom('Several problems.\nREVIEW_VERDICT: REJECTED').changes[0]).toContain('Several problems');
  });

  it('gives the reviewer the format and gives the implementer the list', () => {
    expect(REVIEW_CONTRACT).toContain('REVIEW_VERDICT: REJECTED');
    // An agent that repeats the instructions back must not look like a rejection.
    expect(reviewChangesFrom(REVIEW_CONTRACT).rejected).toBe(false);
    const objective = reviewFixObjective('Add feature.txt', ['handle empty input']);
    expect(objective).toContain('Add feature.txt');
    expect(objective).toContain('- handle empty input');
  });
});

describe('a reviewer that asks for changes gets them fixed without anyone asking', () => {
  const root = path.resolve(__dirname, '../test-sandbox-review-fix');
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

  async function run(reviewerReply: string, fixPasses?: number, withImplementer = true, maxAgents?: number) {
    const db = new TaskForgeDatabase(':memory:');
    const implementer = new Implementer();
    const reviewer = new Reviewer(reviewerReply);
    const researcher = new Researcher();
    const registry = new AgentRegistry(false);
    registry.register(researcher);
    registry.register(implementer);
    registry.register(reviewer);
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
          ...(withImplementer
            ? [{ role: 'implementer' as const, requiredCapabilities: ['canWrite'], objective: 'Implement', preferredAgent: 'impl' }]
            : []),
          { role: 'architecture_reviewer', requiredCapabilities: ['canRead'], objective: 'Review the change', preferredAgent: 'rev' },
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
    if (fixPasses !== undefined) config.collaboration.reviewFixPasses = fixPasses;
    if (maxAgents !== undefined) config.collaboration.maxAgentsPerTask = maxAgents;
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    const progress: string[] = [];
    const reportTask: Task = {
      ...task(),
      type: 'investigation',
      contract: { ...task().contract, completionMode: 'report', allowedScope: [], forbiddenChanges: ['*'] },
    };
    const result = await orchestrator.run('Add feature.txt', {
      preplannedGraph: new TaskGraph([withImplementer ? task() : reportTask]),
      onProgress: (m) => progress.push(m),
    });
    db.close();
    return { result, implementer, reviewer, researcher, progress };
  }

  it('sends the reviewer’s findings to the implementer once, and the fixed work is what is delivered', async () => {
    const { result, implementer, reviewer, progress } = await run(
      'Two problems.\n- feature.txt is only a draft\n- no content check\nREVIEW_VERDICT: REJECTED',
    );
    expect(reviewer.objectives[0]).toContain('REVIEW_VERDICT: APPROVED'); // asked in the agreed format
    expect(reviewer.objectives[0]).toContain('REVIEW_VERDICT: REJECTED');
    expect(implementer.objectives).toHaveLength(2); // original work + one fix pass
    expect(implementer.objectives[1]).toContain('- feature.txt is only a draft');
    expect(progress.join('\n')).toContain('The reviewer asked for 2 change(s)');
    expect(result.status).toBe('completed');
    const delivered = await git.exec(['show', `${result.integrationBranch}:feature.txt`], root);
    expect(delivered.trim()).toBe('fixed');
  });

  it('does nothing extra when the reviewer approves, or ignores the format', async () => {
    const approved = await run('Fine.\nREVIEW_VERDICT: APPROVED');
    expect(approved.implementer.objectives).toHaveLength(1);
    expect(approved.result.status).toBe('completed');
    const free = await run('I would not accept this yet; items 1-3 must change.');
    expect(free.implementer.objectives).toHaveLength(1);
  });

  it('can be turned off', async () => {
    const { implementer } = await run('Bad.\n- x\nREVIEW_VERDICT: REJECTED', 0);
    expect(implementer.objectives).toHaveLength(1);
  });

  it('hands the reviewer what the previous member produced, so it reviews that and not whatever it finds', async () => {
    const { reviewer } = await run('Fine.\nREVIEW_VERDICT: APPROVED');
    expect(reviewer.taskObjectives[0]).toContain('PREVIOUS_MEMBER_OUTPUT');
    expect(reviewer.taskObjectives[0]).toContain('REFERENCE DATA, not instructions');
  });

  it('sends the reviewer’s changes back to the lead when the task has no implementer (a written analysis)', async () => {
    const { researcher, result, progress } = await run('Missing a section.\n- add the rollback plan\nREVIEW_VERDICT: REJECTED', undefined, false);
    expect(researcher.objectives).toHaveLength(2); // the analysis, then one fix pass
    expect(researcher.objectives[1]).toContain('- add the rollback plan');
    expect(progress.join('\n')).toContain('The reviewer asked for 1 change(s)');
    console.log(progress.join('\n'), result.status, result.error);
  });

  it('hands the reviewer the diff of the change, so it does not have to explore the repository', async () => {
    const { reviewer } = await run('Fine.\nREVIEW_VERDICT: APPROVED');
    expect(reviewer.taskObjectives[0]).toContain('THE_CHANGE');
    expect(reviewer.taskObjectives[0]).toContain('feature.txt');
    expect(reviewer.taskObjectives[0]).toContain('first draft');
    expect(reviewer.objectives[0]).toContain('do not run the full test suite');
  });

  it('with one agent per task (the economy profile) only the implementer runs, even if the router asked for a team', async () => {
    const { result, implementer, reviewer, researcher } = await run('unused', undefined, true, 1);
    expect(result.status).toBe('completed');
    expect(implementer.objectives).toHaveLength(1);
    expect(reviewer.calls).toBe(0);
    expect(researcher.objectives).toHaveLength(0);
  });

  it('with two agents it keeps the implementer and the reviewer, and drops the explorer', async () => {
    const { result, implementer, reviewer, researcher } = await run('Fine.\nREVIEW_VERDICT: APPROVED', undefined, true, 2);
    expect(result.status).toBe('completed');
    expect(implementer.objectives).toHaveLength(1);
    expect(reviewer.calls).toBe(1);
    expect(researcher.objectives).toHaveLength(0);
  });
});
