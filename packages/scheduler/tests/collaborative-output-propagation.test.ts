import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { getDefaultConfig } from '@taskforge/shared';

describe('collaborative/parallel execution propagates output into taskOutputs', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-collab-output');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Collab Output Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'collab-output@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Collab Output Test\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore
      }
    }
  });

  it('populates taskOutputs for a "pair" strategy collaborative task, not just single-agent tasks', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const leadAgent = new FakeAgent('codex-lead', 'Codex Lead', [
      { writeFile: { path: 'feature.ts', content: 'export const feature = true;\n' }, gitCommitMessage: 'feat: implement' },
    ]);
    const reviewerAgent = new FakeAgent('claude-reviewer', 'Claude Reviewer', [
      { writeFile: { path: 'feature.test.ts', content: 'test(); \n' }, gitCommitMessage: 'test: review' },
    ]);
    registry.register(leadAgent);
    registry.register(reviewerAgent);

    const pairRouter: RoutingProvider = {
      id: 'mock-pair-router-output',
      route: async () => ({
        strategy: 'pair',
        complexity: 'medium',
        risk: 'medium',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement the feature',
            preferredAgent: 'codex-lead',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review the implementation',
            preferredAgent: 'claude-reviewer',
          },
        ],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'test',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: pairRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-PAIR-OUTPUT',
      title: 'Implement and review a small feature',
      description: 'Implement a small feature with pair review',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-PAIR-OUTPUT',
        objective: 'Implement the feature',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Feature implemented and reviewed'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Implement a small feature with pair review', {
      preplannedGraph: graph,
    });

    expect(result.status).toBe('completed');

    // This is the bug fix under test: previously taskOutputs stayed empty
    // for every collaborative/parallel task because res.output from
    // executeExecutionTeam was only used to feed the completion gate and
    // never written into this.taskOutputs.
    expect(result.taskOutputs).toBeDefined();
    expect(result.taskOutputs?.['TASK-PAIR-OUTPUT']).toBeTruthy();
    expect(result.taskOutputs?.['TASK-PAIR-OUTPUT'].length).toBeGreaterThan(0);

    db.close();
  });
});
