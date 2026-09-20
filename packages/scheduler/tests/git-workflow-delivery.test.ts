import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskForgeDatabase, RunRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { DeliveryService } from '@taskforge/integration';
import { getDefaultConfig } from '@taskforge/shared';
import { RunOrchestrator } from '../src/run-orchestrator.js';

describe('RunOrchestrator Git Workflow Policy integration', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-gitflow');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService.exec(['init', '-b', 'main'], testRepoRoot);
    await gitService.exec(['config', 'user.name', 'TaskForge Bot'], testRepoRoot);
    await gitService.exec(['config', 'user.email', 'bot@taskforge.dev'], testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# GitFlow Test\n');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
    await gitService.createBranch('develop', await gitService.getHeadCommit(testRepoRoot));
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
  });

  async function runGoal(goalDescription: string, taskId: string) {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(
      new FakeAgent('fake-agent', 'Fake Agent', [
        {
          writeFile: { path: `${taskId}.txt`, content: 'done\n' },
          gitCommitMessage: `feat: ${taskId}`,
        },
      ]),
    );

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.git.workflow = 'gitflow';

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: taskId,
      title: taskId,
      description: goalDescription,
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId,
        objective: goalDescription,
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Done'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run(goalDescription, { preplannedGraph: graph });
    expect(result.status).toBe('completed');

    const runRepo = new RunRepository(db);
    const deliveryService = new DeliveryService(testRepoRoot, gitService, runRepo);
    const delivery = deliveryService.getDelivery(result.runId);
    db.close();
    return delivery;
  }

  it('targets develop for a normal feature goal under the gitflow workflow', async () => {
    const delivery = await runGoal('Add commitment intelligence view', 'TASK-FEATURE');
    expect(delivery?.targetBranch).toBe('develop');
  });

  it('targets main for a hotfix-worded goal under the gitflow workflow', async () => {
    const delivery = await runGoal('Hotfix the checkout crash in production', 'TASK-HOTFIX');
    expect(delivery?.targetBranch).toBe('main');
  });
});
