import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDefaultConfig } from '@taskforge/shared';
import {
  AgentDetector,
  AgentQuotaTracker,
  AgentRegistry,
  type AgentAdapter,
} from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

const signedOutAgent: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',
  detect: async () => true,
  authStatus: async () => ({ state: 'signed_out', signInCommand: 'claude auth login' }),
  capabilities: async () => ({
    canRead: true,
    canWrite: true,
    canExecute: true,
    languages: [],
    tools: [],
  }),
  execute: async () => ({ success: true, message: 'should never run', durationMs: 0 }),
};

describe('a run with agents installed but none usable', () => {
  const repo = path.resolve(__dirname, '../test-sandbox-unusable-agents');
  let git: GitService;
  let worktrees: WorktreeManager;

  beforeEach(async () => {
    AgentDetector.resetAuthCache();
    AgentQuotaTracker.resetInstance();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(repo, { recursive: true });
    git = new GitService(repo);
    await git.exec(['init', '-b', 'main'], repo);
    await git.exec(['config', 'user.name', 'T'], repo);
    await git.exec(['config', 'user.email', 't@taskforge.dev'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
    await git.stageAndCommit('Initial commit', repo);
    worktrees = new WorktreeManager(repo, '.taskforge/worktrees');
  });
  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('stops and says why, instead of finishing with the fake agent as if real work was done', async () => {
    const registry = new AgentRegistry(false);
    registry.register(signedOutAgent);
    const router: RoutingProvider = {
      id: 'r',
      route: async () => {
        throw new Error('routing must not be reached');
      },
    };
    const task: Task = {
      id: 'T1',
      goalId: 'g',
      title: 't',
      description: 't',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'o',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['done'],
        dependencies: [],
      },
      acceptanceCriteria: ['done'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const graph = new TaskGraph();
    graph.addTask(task);
    const db = new TaskForgeDatabase(':memory:');
    const orchestrator = new RunOrchestrator({
      repoRoot: repo,
      config: getDefaultConfig(),
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: worktrees,
    });

    await expect(orchestrator.run('Change src.', { preplannedGraph: graph })).rejects.toThrow(
      /No agent can work right now: Claude Code \(not signed in; run "claude auth login"\)/,
    );
    expect(registry.get('fake-agent')).toBeUndefined();
    db.close();
  }, 30_000);
});
