import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentAssignment, AgentCapabilities, AgentContext, AgentResult } from '@taskforge/shared';
import { getDefaultConfig } from '@taskforge/shared';
import { TaskForgeDatabase, EventRepository, TaskRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { AgentRegistry, type AgentAdapter } from '@taskforge/agents';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { describeRunFailures, formatRunFailureLines } from '../src/run-failure-report.js';

class ReportingAgent implements AgentAdapter {
  constructor(
    readonly id: string,
    readonly name: string,
    private output: string,
  ) {}
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: false, canExecute: true, languages: [], tools: [] };
  }
  async execute(_a: AgentAssignment, _c: AgentContext): Promise<AgentResult> {
    return { success: true, message: 'ok', output: this.output, durationMs: 1 };
  }
}

describe('parallel investigation: an empty report is not evidence', () => {
  const root = path.resolve(__dirname, '../test-sandbox-empty-report');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'Empty Report'], root);
    await git.exec(['config', 'user.email', 'empty@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# empty\n');
    await git.stageAndCommit('Initial commit', root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(policy: 'all_required' | 'best_effort') {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(new ReportingAgent('good', 'Good Agent', 'A substantive analysis of the repository.'));
    registry.register(new ReportingAgent('silent', 'Silent Agent', '   \n'));
    const router: RoutingProvider = {
      id: 'investigation-router',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'low',
        uncertainty: 'high',
        teamSize: 2,
        investigationPolicy: policy,
        roles: [
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'Analyse', preferredAgent: 'good' },
          { role: 'architecture_reviewer', requiredCapabilities: ['canRead'], objective: 'Review', preferredAgent: 'silent' },
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
    const task: Task = {
      id: 'TASK-INV',
      goalId: 'g',
      title: 'Investigate the architecture',
      description: 'Read-only analysis',
      type: 'investigation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Analyse the architecture',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['report produced'],
        dependencies: [],
        completionMode: 'report',
      },
      acceptanceCriteria: [],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    const result = await orchestrator.run('Analyse the architecture', { preplannedGraph: new TaskGraph([task]) });
    return { db, result };
  }

  it('fails the task under all_required when one investigator returns nothing', async () => {
    const { db, result } = await run('all_required');
    expect(result.status).toBe('failed');
    db.close();
  });

  it('records the silent role as unsatisfied under best_effort instead of counting it', async () => {
    const { db, result } = await run('best_effort');
    const events = new EventRepository(db).listByRun(result.runId);
    const failed = events.filter((e) => e.type === 'INVESTIGATOR_FAILED');
    expect(JSON.stringify(failed.map((e) => e.payload))).not.toContain('"role":"researcher"');
    expect(result.taskOutputs?.['TASK-INV'] ?? '').not.toContain('architecture_reviewer');
    db.close();
  });

  it('explains the failure: the task, the reason, and that the team path is no longer silent', async () => {
    const progress: string[] = [];
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(new ReportingAgent('good', 'Good Agent', 'A substantive analysis.'));
    registry.register(new ReportingAgent('silent', 'Silent Agent', ''));
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'low',
        uncertainty: 'high',
        teamSize: 2,
        investigationPolicy: 'all_required',
        roles: [
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'a', preferredAgent: 'good' },
          { role: 'architecture_reviewer', requiredCapabilities: ['canRead'], objective: 'b', preferredAgent: 'silent' },
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
    const first: Task = {
      id: 'TASK-A',
      goalId: 'g',
      title: 'Map the project',
      description: 'Read-only analysis',
      type: 'investigation',
      status: 'accepted',
      dependencies: [],
      contract: { objective: 'Map', allowedScope: [], forbiddenChanges: ['*'], acceptanceCriteria: ['report'], dependencies: [], completionMode: 'report' },
      acceptanceCriteria: [],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const second: Task = { ...first, id: 'TASK-B', title: 'Consolidate gaps', dependencies: ['TASK-A'], contract: { ...first.contract, dependencies: ['TASK-A'] } };
    const orchestrator = new RunOrchestrator({ repoRoot: root, config, database: db, agentRegistry: registry, router, gitService: git, worktreeManager: worktrees });
    const result = await orchestrator.run('Map then consolidate', {
      preplannedGraph: new TaskGraph([first, second]),
      onProgress: (m) => progress.push(m),
    });

    expect(result.status).toBe('failed');
    // The team path used to end the task silently; now it says so.
    expect(progress.join('\n')).toMatch(/\[TASK-A\] ✗ Team execution failed/);

    const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) }, result.runId);
    const failed = lines.find((l) => l.taskId === 'TASK-A');
    expect(failed?.kind).toMatch(/failed|blocked/);
    expect(failed?.reason).toMatch(/Silent Agent|report|unsatisfied|Investigation/i);
    const notStarted = lines.find((l) => l.taskId === 'TASK-B');
    expect(notStarted).toMatchObject({ kind: 'not_started', waitingOn: ['TASK-A'] });

    const text = formatRunFailureLines(lines, result.runId).join('\n');
    expect(text).toContain('Why the run did not complete');
    expect(text).toContain(`tf resume ${result.runId}`);
    db.close();
  });
});
