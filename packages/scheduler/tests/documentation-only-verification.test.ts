import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

class FileWriter implements AgentAdapter {
  readonly id = 'writer';
  readonly name = 'Writer';
  constructor(private files: string[]) {}
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(_a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const git = new GitService(context.worktreePath);
    for (const file of this.files) {
      const full = path.join(context.worktreePath, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'changed\n');
    }
    const commitHash = await git.stageAndCommit('change', context.worktreePath);
    return { success: true, message: 'ok', output: 'done', durationMs: 1, commitHash };
  }
}

function task(): Task {
  return {
    id: 'TASK-DOC',
    goalId: 'g',
    title: 'Update project state',
    description: 'Update project state',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Update docs/project-state.md',
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['updated'],
      dependencies: [],
      completionMode: 'mutation',
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('documentation-only changes in a project with no verification setup', () => {
  const root = path.resolve(__dirname, '../test-sandbox-docs-only');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'Docs Only'], root);
    await git.exec(['config', 'user.email', 'docs@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# not a node project\n'); // no package.json
    await git.stageAndCommit('Initial commit', root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(files: string[], patch: (c: ReturnType<typeof getDefaultConfig>) => void = () => {}) {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(new FileWriter(files));
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'implementer', requiredCapabilities: ['canRead', 'canWrite'], objective: 'x', preferredAgent: 'writer' }],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'deterministic',
      }),
    };
    const config = getDefaultConfig(); // tests/lint/typecheck verification stays ON (default)
    config.verification.review = false;
    patch(config);
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });
    const result = await orchestrator.run('Update project state', { preplannedGraph: new TaskGraph([task()]) });
    db.close();
    return result;
  }

  it('completes a documentation-only change instead of blocking it', async () => {
    const result = await run(['docs/project-state.md']);
    expect(result.status).toBe('completed');
  });

  it('still blocks a code change when there is nothing to verify it with', async () => {
    const result = await run(['server/app.py']);
    expect(result.status).toBe('failed');
  });

  it('a mixed change (docs + code) is treated as code', async () => {
    const result = await run(['docs/project-state.md', 'server/app.py']);
    expect(result.status).toBe('failed');
  });

  it('runs configured verification commands even for a documentation-only change', async () => {
    const result = await run(['docs/project-state.md'], (c) => {
      c.verification.commands = ['false'];
    });
    expect(result.status).toBe('failed');
  });
});
