import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentResult,
  getDefaultConfig,
} from '@taskforge/shared';
import { AgentAdapter, AgentActivityTracker, AgentRegistry } from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, Task } from '@taskforge/core';
import { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

class TimeoutProbeAgent implements AgentAdapter {
  readonly id = 'timeout-probe';
  readonly name = 'Timeout Probe';
  public observedTimeoutMs?: number;
  public observedOriginalUserRequest?: string;
  public observedRole?: AgentAssignment['role'];

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['bash', 'file_editor', 'git'],
    };
  }

  async execute(
    _assignment: AgentAssignment,
    context: AgentContext,
  ): Promise<AgentResult> {
    this.observedTimeoutMs = context.timeoutMs;
    this.observedOriginalUserRequest = context.originalUserRequest;
    this.observedRole = _assignment.role;
    return {
      success: true,
      message: 'Investigation completed successfully',
      output:
        'Detailed investigation report confirming the execution timeout supplied by the TaskForge control plane.',
      durationMs: 1,
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 300,
        totalTokens: 1300,
        modelName: 'probe-model',
        source: 'provider_reported',
      },
    };
  }
}

describe('governed assignment execution timeout', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-execution-timeout');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Timeout Test'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'timeout@taskforge.dev'], testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# timeout test\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
  });

  it('passes execution.defaultTimeoutMinutes to the agent instead of the adapter-local five-minute default', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    const activityTracker = new AgentActivityTracker();
    const agent = new TimeoutProbeAgent();
    registry.register(agent);

    const router: RoutingProvider = {
      id: 'timeout-test-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Inspect runtime timeout behavior',
            preferredAgent: agent.id,
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'test',
      }),
    };

    const config = getDefaultConfig();
    config.execution.defaultTimeoutMinutes = 17;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-TIMEOUT',
      goalId: 'goal-timeout',
      title: 'Inspect execution timeout',
      description: 'Analyze the runtime timeout behavior without modifying anything.',
      type: 'investigation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Produce a timeout analysis',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Return a substantive timeout report'],
        dependencies: [],
      },
      acceptanceCriteria: ['Return a substantive timeout report'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    graph.addTask(task);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      activityTracker,
      router,
      gitService,
      worktreeManager,
    });

    const result = await orchestrator.run(
      'Analyze the runtime timeout behavior without modifying anything.',
      { preplannedGraph: graph },
    );

    expect(result.status).toBe('completed');
    expect(agent.observedTimeoutMs).toBe(17 * 60_000);
    expect(agent.observedOriginalUserRequest).toBe(
      'Analyze the runtime timeout behavior without modifying anything.',
    );
    expect(agent.observedRole).toBe('researcher');
    expect(activityTracker.getActive()).toEqual([]);

    const usageRow = db
      .prepare(
        'SELECT assignment_id, role, model_name, input_tokens, cached_input_tokens, output_tokens, total_tokens, usage_source, planned_estimated_tokens FROM cost_tracking LIMIT 1',
      )
      .get() as Record<string, unknown> | undefined;
    expect(usageRow).toBeDefined();
    expect(usageRow?.role).toBe('researcher');
    expect(usageRow?.model_name).toBe('probe-model');
    expect(usageRow?.input_tokens).toBe(1000);
    expect(usageRow?.cached_input_tokens).toBe(200);
    expect(usageRow?.output_tokens).toBe(300);
    expect(usageRow?.total_tokens).toBe(1300);
    expect(usageRow?.usage_source).toBe('provider_reported');
    expect(Number(usageRow?.planned_estimated_tokens)).toBeGreaterThan(0);

    db.close();
  });
});
