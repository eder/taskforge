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
import { TaskForgeDatabase, TaskRepository, EventRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { describeRunFailures, formatRunFailureLines } from '../src/run-failure-report.js';

/**
 * The combinations that happen on real projects: how the work is staffed (one
 * agent, or a team that ends in a reviewer) crossed with what goes wrong (nothing,
 * the checks fail, an agent fails, the token cap is hit) and then a resume once the
 * cause is gone. Every one must end in one of two states: completed with the work
 * delivered, or stopped with a reason the person can act on and the work kept.
 * Never an exception, a raw git error, or lost work.
 */
type Strategy = 'single' | 'team';
type Fault = 'none' | 'checks_fail_then_pass' | 'agent_fails_then_ok' | 'token_cap_then_raised';

const CHECK = `node -e "if(!require('fs').existsSync('ok.flag')){console.error('AssertionError: ok.flag is missing');process.exit(1)}"`;

interface World {
  /** Whether the implementer produces ok.flag (what the check needs). */
  writeFlag: boolean;
  /** The implementer fails its next call. */
  failNext: boolean;
  /** Tokens reported by each implementer call. */
  tokens: number;
  implCalls: number;
}

const read = (id: string, name: string): AgentAdapter => ({
  id,
  name,
  detect: async () => true,
  capabilities: async (): Promise<AgentCapabilities> => ({ canRead: true, canWrite: false, canExecute: false, languages: [], tools: [] }),
  execute: async (): Promise<AgentResult> => {
    const reply = id === 'rev' ? 'Fine.\nREVIEW_VERDICT: APPROVED' : 'Studied the area.';
    return { success: true, message: reply, output: reply, durationMs: 1 };
  },
});

function implementer(world: World): AgentAdapter {
  return {
    id: 'impl',
    name: 'Implementer',
    detect: async () => true,
    capabilities: async (): Promise<AgentCapabilities> => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] }),
    execute: async (assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> => {
      world.implCalls += 1;
      if (world.failNext) {
        world.failNext = false;
        return { success: false, message: 'simulated agent failure', durationMs: 1 };
      }
      fs.writeFileSync(path.join(context.worktreePath, `${assignment.taskId}.txt`), `done by call ${world.implCalls}\n`);
      if (world.writeFlag) fs.writeFileSync(path.join(context.worktreePath, 'ok.flag'), 'ok\n');
      const git = new GitService(context.worktreePath);
      const commitHash = await git.stageAndCommit(`work for ${assignment.taskId}`, context.worktreePath);
      return {
        success: true,
        message: 'done',
        durationMs: 1,
        commitHash,
        usage: { inputTokens: world.tokens, outputTokens: 0, totalTokens: world.tokens, modelName: 'm', source: 'provider_reported' },
      };
    },
  };
}

function task(id: string, dependencies: string[] = []): Task {
  return {
    id,
    goalId: 'g',
    title: `Do ${id}`,
    description: id,
    type: 'implementation',
    status: 'accepted',
    dependencies,
    contract: {
      objective: `Produce ${id}.txt`,
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: [`${id}.txt exists`],
      dependencies,
      completionMode: 'mutation',
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('scenario matrix: every way a run can go wrong ends in a clear, recoverable state', () => {
  const root = path.resolve(__dirname, '../test-sandbox-matrix');
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

  const scenarios: Array<[Strategy, Fault]> = (['single', 'team'] as const).flatMap((strategy) =>
    (['none', 'checks_fail_then_pass', 'agent_fails_then_ok', 'token_cap_then_raised'] as const).map(
      (fault) => [strategy, fault] as [Strategy, Fault],
    ),
  );

  it.each(scenarios)('%s staffing, fault: %s', async (strategy, fault) => {
    const world: World = { writeFlag: fault !== 'checks_fail_then_pass', failNext: fault === 'agent_fails_then_ok', tokens: fault === 'token_cap_then_raised' ? 600 : 10, implCalls: 0 };
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(implementer(world));
    if (strategy === 'team') {
      registry.register(read('res', 'Researcher'));
      registry.register(read('rev', 'Reviewer'));
    }
    const router: RoutingProvider = {
      id: 'r',
      route: async () =>
        strategy === 'single'
          ? {
              strategy: 'single',
              complexity: 'low',
              risk: 'low',
              uncertainty: 'low',
              teamSize: 1,
              roles: [{ role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'x', preferredAgent: 'impl' }],
              communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
              reason: 'test',
            }
          : {
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
            },
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.verification.commands = [CHECK];
    config.verification.preflight = false; // the preflight has its own tests; here the fault must happen mid-run
    config.verification.maxReworkCycles = 0; // look at the first outcome of each fault
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    const graph = () => new TaskGraph([task('TASK-A'), task('TASK-B', ['TASK-A'])]);

    // 1. The first attempt never throws.
    const first = await orchestrator.run('Produce the files', {
      preplannedGraph: graph(),
      tokenBudget: fault === 'token_cap_then_raised' ? 500 : undefined,
    });
    expect(['completed', 'failed']).toContain(first.status);
    expect(first.error ?? '').not.toMatch(/cherry-pick|Git command failed|hint:/);

    if (first.status === 'completed') {
      expect(fault).toBe('none');
    } else {
      // 2. A stop is explained in words the person can act on, and nothing is lost.
      expect(fault).not.toBe('none');
      const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) }, first.runId);
      expect(lines.length).toBeGreaterThan(0);
      const report = formatRunFailureLines(lines, first.runId, { repoRoot: root }).join('\n');
      expect(report).toContain('Why the run did not complete');
      expect(report).not.toMatch(/cherry-pick|hint:/);

      // 3. Once the cause is gone, resuming finishes the job.
      world.writeFlag = true;
      world.failNext = false;
      const resumed = await orchestrator.resume(first.runId, { tokenBudget: 1_000_000 });
      expect(resumed.error ?? '').not.toMatch(/cherry-pick|Git command failed|hint:/);
      expect(resumed.status).toBe('completed');

      // 4. The delivered branch has everything: both tasks' files, and the flag the check needs.
      for (const file of ['TASK-A.txt', 'TASK-B.txt', 'ok.flag']) {
        const shown = await git.exec(['show', `${resumed.integrationBranch}:${file}`], root).catch(() => '');
        expect(shown.trim().length, `${file} should be in ${resumed.integrationBranch}`).toBeGreaterThan(0);
      }
    }
    db.close();
  }, 180_000);

  it('the token cap also stops a team between its members, not only between tasks', async () => {
    const world: World = { writeFlag: true, failNext: false, tokens: 600, implCalls: 0 };
    let reviewerCalls = 0;
    const reviewer = read('rev', 'Reviewer');
    const countingReviewer: AgentAdapter = {
      ...reviewer,
      execute: async (a, c) => {
        reviewerCalls += 1;
        return reviewer.execute(a, c);
      },
    };
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(read('res', 'Researcher'));
    registry.register(implementer(world));
    registry.register(countingReviewer);
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
    config.verification.preflight = false;
    const orchestrator = new RunOrchestrator({ repoRoot: root, config, database: db, agentRegistry: registry, router, gitService: git, worktreeManager: worktrees });

    const first = await orchestrator.run('Produce the file', { preplannedGraph: new TaskGraph([task('TASK-A')]), tokenBudget: 500 });

    // The implementer used 600 tokens (> 500): the reviewer must not be started.
    expect(first.status).toBe('failed');
    expect(reviewerCalls).toBe(0);
    const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) }, first.runId);
    expect(lines.some((l) => l.kind === 'budget')).toBe(true);
    expect(lines.some((l) => l.keptBranch)).toBe(true); // the implementer's work is kept

    const resumed = await orchestrator.resume(first.runId, { tokenBudget: 1_000_000 });
    expect(resumed.status).toBe('completed');
    db.close();
  }, 120_000);
});
