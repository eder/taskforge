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
import { SemanticPlanner } from '@taskforge/planner';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

class Fails implements AgentAdapter {
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

function task(): Task {
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

describe('model-assisted execution intent in the orchestrator', () => {
  const root = path.resolve(__dirname, '../test-sandbox-model-intent');
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

  function build(planner: SemanticPlanner) {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(new Fails());
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
      planner,
      gitService: git,
      worktreeManager: worktrees,
    });
    return { db, orchestrator };
  }

  it('records the stricter intent the model found for a language the patterns do not know, and keeps it on resume', async () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    planner.setIntentJudge(async () => ({ readOnly: true, forbiddenTargets: [] }));
    const { db, orchestrator } = build(planner);

    // Spanish: no deterministic pattern knows "no modifiques nada".
    const run = await orchestrator.run('No modifiques nada del repositorio, dime qué falta', {
      preplannedGraph: new TaskGraph([task()]),
    });

    const metadata = JSON.parse(new RunRepository(db).get(run.runId)!.metadataJson!);
    expect(metadata.executionIntent.intent).toBe('READ_ONLY_ANALYSIS');
    expect(metadata.executionIntent.mutationAllowed).toBe(false);
    db.close();
  });

  it('never loosens: a model saying "implementation" does not override a deterministic read-only ban', async () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    planner.setIntentJudge(async () => ({ readOnly: false, forbiddenTargets: [] }));
    const { db, orchestrator } = build(planner);

    const run = await orchestrator.run('Do not modify anything, just explain the project', {
      preplannedGraph: new TaskGraph([task()]),
    });

    const metadata = JSON.parse(new RunRepository(db).get(run.runId)!.metadataJson!);
    expect(metadata.executionIntent.mutationAllowed).toBe(false);
    db.close();
  });

  it('keeps the deterministic result when the model fails', async () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    planner.setIntentJudge(async () => {
      throw new Error('down');
    });
    const { db, orchestrator } = build(planner);

    const run = await orchestrator.run('implement the retry loop', { preplannedGraph: new TaskGraph([task()]) });

    const metadata = JSON.parse(new RunRepository(db).get(run.runId)!.metadataJson!);
    expect(metadata.executionIntent.intent).toBe('IMPLEMENTATION');
    db.close();
  });
});
