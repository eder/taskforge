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
import { TaskForgeDatabase, EventRepository, AssignmentRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

class ImplementerAgent implements AgentAdapter {
  readonly id = 'impl';
  readonly name = 'Implementer';
  public calls = 0;

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls++;
    const git = new GitService(context.worktreePath);
    fs.mkdirSync(path.join(context.worktreePath, 'src/auth'), { recursive: true });
    // Each attempt changes the file so a retry always produces a new commit.
    fs.appendFileSync(path.join(context.worktreePath, 'src/auth/login.ts'), `export const v${this.calls} = ${this.calls};\n`);
    const commitHash = await git.stageAndCommit(`feat: auth attempt ${this.calls}`, context.worktreePath);
    return { success: true, message: 'done', output: `implemented ${assignment.taskId}`, durationMs: 1, commitHash };
  }
}

class ReviewerAgent implements AgentAdapter {
  readonly id = 'rev';
  readonly name = 'Reviewer';
  public objectives: string[] = [];
  public sawCandidateFile = false;

  constructor(public reply: (call: number) => string) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: false, canExecute: true, languages: [], tools: ['git'] };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.objectives.push(assignment.objective);
    this.sawCandidateFile = fs.existsSync(path.join(context.worktreePath, 'src/auth/login.ts'));
    return { success: true, message: 'reviewed', output: this.reply(this.objectives.length), durationMs: 1 };
  }
}

function authTask(): Task {
  return {
    id: 'TASK-AUTH',
    goalId: 'goal-dual-review',
    title: 'Add login handler',
    description: 'Add login handler',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Implement the login handler',
      allowedScope: ['src/auth/**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['login handler exists'],
      dependencies: [],
    },
    acceptanceCriteria: ['login handler exists'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('dual-review gate', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-dual-review');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
    fs.mkdirSync(testRepoRoot, { recursive: true });
    gitService = new GitService(testRepoRoot);
    await gitService.exec(['init', '-b', 'main'], testRepoRoot);
    await gitService.exec(['config', 'user.name', 'Dual Review Test'], testRepoRoot);
    await gitService.exec(['config', 'user.email', 'review@taskforge.dev'], testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# dual review\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
  });

  function setup(agents: AgentAdapter[], policy: Record<string, unknown> = {}, enabled = true) {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    agents.forEach((a) => registry.register(a));
    const router: RoutingProvider = {
      id: 'dual-review-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'medium',
        risk: 'high',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canRead', 'canWrite'],
            objective: 'Implement the change',
            preferredAgent: 'impl',
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
    // Only the implementer may write to src/auth: makes staffing deterministic.
    config.ownership = { rules: [{ scope: 'src/auth/**', writers: ['impl'] }] };
    config.verification.dualReview = {
      ...config.verification.dualReview,
      enabled,
      scopes: ['src/auth/**'],
      ...policy,
    };
    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService,
      worktreeManager,
    });
    const graph = new TaskGraph();
    graph.addTask(authTask());
    return { db, orchestrator, graph };
  }

  const eventTypes = (db: TaskForgeDatabase, runId: string) =>
    new EventRepository(db).listByRun(runId).map((e) => e.type);

  it('integrates a sensitive change only after an independent agent approves it', async () => {
    const impl = new ImplementerAgent();
    const rev = new ReviewerAgent(() => 'Reads cleanly, no auth bypass found.\nREVIEW_VERDICT: APPROVED');
    const { db, orchestrator, graph } = setup([impl, rev]);

    const result = await orchestrator.run('Add login handler', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(rev.objectives).toHaveLength(1);
    expect(rev.objectives[0]).toContain('INDEPENDENT REVIEWER');
    expect(rev.sawCandidateFile).toBe(true); // reviewed the candidate commit, not the base
    const types = eventTypes(db, result.runId);
    expect(types).toContain('DUAL_REVIEW_REQUIRED');
    expect(types).toContain('DUAL_REVIEW_APPROVED');
    const reviewAssignments = new AssignmentRepository(db)
      .listByTask('TASK-AUTH')
      .filter((a) => a.id.includes('-review-'));
    expect(reviewAssignments).toHaveLength(1);
    expect(reviewAssignments[0].agentId).toBe('rev');
    expect(reviewAssignments[0].agentId).not.toBe('impl');
    const files = await gitService.exec(['ls-tree', '-r', '--name-only', result.integrationBranch!], testRepoRoot);
    expect(files).toContain('src/auth/login.ts');
    db.close();
  });

  it('never integrates a change the reviewer rejects, and feeds findings back as evidence', async () => {
    const impl = new ImplementerAgent();
    const rev = new ReviewerAgent(() => '- login.ts: token never expires\nREVIEW_VERDICT: REJECTED');
    const { db, orchestrator, graph } = setup([impl, rev]);

    const result = await orchestrator.run('Add login handler', { preplannedGraph: graph });

    expect(result.status).toBe('failed');
    expect(result.tasksCompleted).toBe(0);
    expect(result.integrationBranch).toBeUndefined();
    expect(eventTypes(db, result.runId)).toContain('DUAL_REVIEW_REJECTED');
    // The rework attempt was driven by the reviewer's findings.
    const recovery = new EventRepository(db)
      .listByRun(result.runId)
      .find((e) => e.type === 'TASK_RECOVERY_SCHEDULED' || e.type === 'TASK_RECOVERY_BLOCKED');
    expect(JSON.stringify(recovery?.payload)).toContain('token never expires');
    expect(impl.calls).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('treats a missing verdict as a rejection (fail closed)', async () => {
    const impl = new ImplementerAgent();
    const rev = new ReviewerAgent(() => 'Everything looks fine to me!');
    const { db, orchestrator, graph } = setup([impl, rev]);

    const result = await orchestrator.run('Add login handler', { preplannedGraph: graph });

    expect(result.status).toBe('failed');
    expect(eventTypes(db, result.runId)).toContain('DUAL_REVIEW_REJECTED');
    db.close();
  });

  it('blocks when no independent reviewer exists (default policy)', async () => {
    const impl = new ImplementerAgent();
    const { db, orchestrator, graph } = setup([impl]);

    const result = await orchestrator.run('Add login handler', { preplannedGraph: graph });

    expect(result.status).toBe('failed');
    expect(result.integrationBranch).toBeUndefined();
    expect(eventTypes(db, result.runId)).toContain('DUAL_REVIEW_UNAVAILABLE');
    db.close();
  });

  it('can skip review explicitly when onNoIndependentReviewer is "skip"', async () => {
    const impl = new ImplementerAgent();
    const { db, orchestrator, graph } = setup([impl], { onNoIndependentReviewer: 'skip' });

    const result = await orchestrator.run('Add login handler', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(eventTypes(db, result.runId)).toContain('DUAL_REVIEW_UNAVAILABLE');
    db.close();
  });

  it('does nothing when the gate is disabled (default)', async () => {
    const impl = new ImplementerAgent();
    const rev = new ReviewerAgent(() => 'REVIEW_VERDICT: REJECTED');
    const { db, orchestrator, graph } = setup([impl, rev], {}, false);

    const result = await orchestrator.run('Add login handler', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(rev.objectives).toHaveLength(0);
    expect(eventTypes(db, result.runId)).not.toContain('DUAL_REVIEW_REQUIRED');
    db.close();
  });
});
