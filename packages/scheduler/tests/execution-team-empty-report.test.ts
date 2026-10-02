import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentAssignment, AgentCapabilities, AgentContext, AgentResult } from '@taskforge/shared';
import { getDefaultConfig } from '@taskforge/shared';
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { AgentRegistry, type AgentAdapter } from '@taskforge/agents';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

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
});
