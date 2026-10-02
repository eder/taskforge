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
import { TaskForgeDatabase, TaskRepository, AssignmentRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { applyTaskIdRemap, planTaskIdRemap } from '../src/task-id-allocation.js';

function task(id: string, dependencies: string[] = [], extra: Partial<Task['contract']> = {}): Task {
  return {
    id,
    goalId: 'goal',
    title: `Do ${id}`,
    description: `Depends on ${dependencies.join(', ') || 'nothing'}`,
    type: 'implementation',
    status: 'accepted',
    dependencies,
    contract: {
      objective: `Implement ${id}`,
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: [`${id} done`],
      dependencies,
      ...extra,
    },
    acceptanceCriteria: [`${id} done`],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('task id renumbering', () => {
  it('leaves graphs without a clash untouched', () => {
    const graph = new TaskGraph([task('TASK-01'), task('TASK-02', ['TASK-01'])]);
    expect(planTaskIdRemap(graph, { isTaken: () => false, maxNumericId: () => 0 }, 'run-1')).toBeUndefined();
  });

  it('renumbers past the highest used id and rewrites dependencies everywhere', () => {
    const graph = new TaskGraph(
      [
        task('TASK-01'),
        task('TASK-02', ['TASK-01'], { metadata: { note: 'see TASK-01 and TASK-10' } }),
      ],
      { source: 'TASK-02' },
    );
    const taken = new Set(['TASK-01', 'TASK-02', 'TASK-03']);
    const mapping = planTaskIdRemap(
      graph,
      { isTaken: (id) => taken.has(id), maxNumericId: () => 3 },
      'run-1790907000123456',
    )!;
    expect([...mapping]).toEqual([
      ['TASK-01', 'TASK-04'],
      ['TASK-02', 'TASK-05'],
    ]);

    const renamed = applyTaskIdRemap(graph, mapping);
    const t5 = renamed.getTask('TASK-05')!;
    expect(t5.dependencies).toEqual(['TASK-04']);
    expect(t5.contract.dependencies).toEqual(['TASK-04']);
    expect(t5.contract.metadata?.note).toBe('see TASK-04 and TASK-10'); // TASK-10 is not TASK-01
    expect(renamed.metadata).toEqual({ source: 'TASK-05' });
    expect(renamed.getTask('TASK-01')).toBeUndefined();
  });

  it('gives non-numbered ids a run-specific suffix', () => {
    const graph = new TaskGraph([task('TASK-AUTH')]);
    const mapping = planTaskIdRemap(
      graph,
      { isTaken: (id) => id === 'TASK-AUTH', maxNumericId: () => 0 },
      'run-1790907000123456',
    )!;
    expect(mapping.get('TASK-AUTH')).toBe('TASK-AUTH-123456');
  });
});

class NoopWriter implements AgentAdapter {
  readonly id = 'noop';
  readonly name = 'Noop';
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const git = new GitService(context.worktreePath);
    fs.writeFileSync(path.join(context.worktreePath, `${assignment.id}.txt`), 'x\n');
    const commitHash = await git.stageAndCommit(`feat: ${assignment.taskId}`, context.worktreePath);
    return { success: true, message: 'ok', output: 'ok', durationMs: 1, commitHash };
  }
}

describe('multiple runs in one database', () => {
  const root = path.resolve(__dirname, '../test-sandbox-multi-run');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'Multi Run'], root);
    await git.exec(['config', 'user.email', 'multi@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# multi\n');
    await git.stageAndCommit('Initial commit', root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the first run intact when a second run reuses TASK-01 ids', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(new NoopWriter());
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'implementer', requiredCapabilities: ['canRead', 'canWrite'], objective: 'x', preferredAgent: 'noop' }],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'deterministic',
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

    const first = await orchestrator.run('first goal', {
      preplannedGraph: new TaskGraph([task('TASK-01'), task('TASK-02', ['TASK-01'])]),
    });
    const progress: string[] = [];
    const second = await orchestrator.run('second goal', {
      preplannedGraph: new TaskGraph([task('TASK-01'), task('TASK-02', ['TASK-01'])]),
      onProgress: (m) => progress.push(m),
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(progress.join('\n')).toContain('renumbered');

    const taskRepo = new TaskRepository(db);
    const firstTasks = taskRepo.listByRun(first.runId).map((t) => t.id).sort();
    const secondTasks = taskRepo.listByRun(second.runId).map((t) => t.id).sort();
    expect(firstTasks).toEqual(['TASK-01', 'TASK-02']);
    expect(secondTasks).toEqual(['TASK-03', 'TASK-04']);
    expect(new Set([...firstTasks, ...secondTasks]).size).toBe(4);

    // The first run's assignments and dependencies survived the second run.
    expect(new AssignmentRepository(db).listByRun(first.runId)).toHaveLength(2);
    expect(taskRepo.get('TASK-02')?.dependencies).toEqual(['TASK-01']);
    expect(taskRepo.get('TASK-04')?.dependencies).toEqual(['TASK-03']);
    db.close();
  });
});
