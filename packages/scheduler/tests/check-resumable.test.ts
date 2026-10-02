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

class AlwaysFails implements AgentAdapter {
  readonly id = 'fails';
  readonly name = 'Fails';
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(_a: AgentAssignment, _c: AgentContext): Promise<AgentResult> {
    return { success: false, message: 'simulated failure', durationMs: 1 };
  }
}

function oneTask(): Task {
  return {
    id: 'TASK-ONE',
    goalId: 'g',
    title: 'One',
    description: 'One',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Do one thing',
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['done'],
      dependencies: [],
      completionMode: 'mutation',
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RunOrchestrator.checkResumable', () => {
  const root = path.resolve(__dirname, '../test-sandbox-check-resumable');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'Check Resumable'], root);
    await git.exec(['config', 'user.email', 'check@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# check\n');
    await git.stageAndCommit('Initial commit', root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function failedRun() {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(new AlwaysFails());
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'x', preferredAgent: 'fails' }],
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
    const run = await orchestrator.run('goal', { preplannedGraph: new TaskGraph([oneTask()]) });
    return { db, orchestrator, runId: run.runId };
  }

  it('is undefined for a failed run that can be continued', async () => {
    const { db, orchestrator, runId } = await failedRun();
    expect(await orchestrator.checkResumable(runId)).toBeUndefined();
    db.close();
  });

  it('explains a run from before resume checkpoints existed, in actionable words', async () => {
    const { db, orchestrator, runId } = await failedRun();
    new RunRepository(db).mergeMetadata(runId, { baseCommit: undefined });
    const reason = await orchestrator.checkResumable(runId);
    expect(reason).toContain('before TaskForge recorded resume checkpoints');
    expect(reason).toContain('Start a new run');
    db.close();
  });

  it('explains unknown runs without side effects on the run', async () => {
    const { db, orchestrator, runId } = await failedRun();
    expect(await orchestrator.checkResumable('run-nope')).toContain('not found');
    // Checking must not change anything: the run is still failed and resumable.
    expect(new RunRepository(db).get(runId)?.status).toBe('failed');
    expect(await orchestrator.checkResumable(runId)).toBeUndefined();
    db.close();
  });

  it('an abandoned run is not resumable, with a clear reason', async () => {
    const { db, orchestrator, runId } = await failedRun();
    new RunRepository(db).updateStatus(runId, 'abandoned');
    const reason = await orchestrator.checkResumable(runId);
    expect(reason).toContain('was abandoned');
    await expect(orchestrator.resume(runId)).rejects.toThrow(/abandoned/);
    db.close();
  });

  it('tells the user when the repository moved on since the run started', async () => {
    const { db, orchestrator, runId } = await failedRun();
    fs.writeFileSync(path.join(root, 'later.txt'), 'later\n');
    await git.stageAndCommit('a later commit', root);
    const progress: string[] = [];
    await orchestrator.resume(runId, { onProgress: (m) => progress.push(m) });
    const note = progress.find((m) => m.startsWith('Note: this run started from'));
    expect(note).toContain('moved on by 1 commit');
    expect(note).toContain(`tf abandon ${runId}`);
    db.close();
  });
});

