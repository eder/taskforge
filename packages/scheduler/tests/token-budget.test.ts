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
import { TaskForgeDatabase, EventRepository, TaskRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import { TelemetryCollector } from '@taskforge/telemetry';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { describeRunFailures, formatRunFailureLines } from '../src/run-failure-report.js';

class Reporter implements AgentAdapter {
  readonly id = 'rep';
  readonly name = 'Reporter';
  calls = 0;
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: false, canExecute: false, languages: [], tools: [] };
  }
  async execute(_a: AgentAssignment, _c: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    return {
      success: true,
      message: 'A substantive written analysis of the area.',
      durationMs: 1,
      usage: { inputTokens: 600, outputTokens: 0, totalTokens: 600, modelName: 'm', source: 'provider_reported' },
    };
  }
}

function reportTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    goalId: 'g',
    title: id,
    description: id,
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

describe('execution.tokenBudget', () => {
  const root = path.resolve(__dirname, '../test-sandbox-token-budget');
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
    await worktrees.prune().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  function build() {
    const db = new TaskForgeDatabase(':memory:');
    const agent = new Reporter();
    const registry = new AgentRegistry(false);
    registry.register(agent);
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'researcher', requiredCapabilities: ['canRead'], objective: 'x', preferredAgent: 'rep' }],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'test',
      }),
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    return { db, agent, orchestrator };
  }

  const graph = () => new TaskGraph([reportTask('TASK-A'), reportTask('TASK-B', ['TASK-A'])]);

  it('stops starting tasks once the budget is spent, says so, and resumes with a higher budget', async () => {
    const { db, agent, orchestrator } = build();
    const progress: string[] = [];

    const first = await orchestrator.run('Analyse the area', {
      preplannedGraph: graph(),
      tokenBudget: 500,
      onProgress: (m) => progress.push(m),
    });

    expect(first.status).toBe('failed');
    expect(agent.calls).toBe(1); // TASK-B never started
    expect(first.error).toContain('Token budget reached');
    expect(progress.join('\n')).toContain('Token budget reached');
    const events = new EventRepository(db).listByRun(first.runId);
    expect(events.some((e) => e.type === 'TOKEN_BUDGET_REACHED')).toBe(true);

    const lines = formatRunFailureLines(
      describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) }, first.runId),
      first.runId,
    );
    expect(lines.join('\n')).toContain('Stopped at the token budget: 600 of 500 tokens');
    expect(lines.join('\n')).toContain(`tf resume ${first.runId} --budget`);

    const resumed = await orchestrator.resume(first.runId, { tokenBudget: 5000 });
    expect(resumed.status).toBe('completed');
    expect(agent.calls).toBe(2);
    // The budget counts the whole run, not only the new attempt.
    expect(new TelemetryCollector(db).getRunTokenTotal(first.runId)).toBe(1200);
    db.close();
  });

  it('does nothing without a budget', async () => {
    const { db, agent, orchestrator } = build();
    const result = await orchestrator.run('Analyse the area', { preplannedGraph: graph() });
    expect(result.status).toBe('completed');
    expect(agent.calls).toBe(2);
    db.close();
  });

  it('reports what the run spent, against the plan and the budget', async () => {
    const { db, orchestrator } = build();
    const result = await orchestrator.run('Analyse the area', { preplannedGraph: graph(), tokenBudget: 5000 });
    const line = new TelemetryCollector(db).formatSpendLine(result.runId, 5000);
    expect(line).toContain('Tokens used: 1,200');
    expect(line).toContain('24% of the 5,000 budget');
    db.close();
  });

  it('says plainly when the agents reported no usage', () => {
    const db = new TaskForgeDatabase(':memory:');
    expect(new TelemetryCollector(db).formatSpendLine('run-none')).toContain('no usage was reported');
    db.close();
  });
});
