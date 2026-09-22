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
import { TaskForgeDatabase } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';

class DependencyAwareAgent implements AgentAdapter {
  readonly id = 'dependency-aware';
  readonly name = 'Dependency Aware Agent';
  public downstreamSawUpstream = false;

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['file_editor', 'git'],
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const git = new GitService(context.worktreePath);

    if (assignment.taskId === 'TASK-UPSTREAM') {
      fs.writeFileSync(
        path.join(context.worktreePath, 'llm-provider.ts'),
        'export interface LLMProvider { generateStructured(): Promise<unknown>; }\n',
        'utf8',
      );
      const commitHash = await git.stageAndCommit(
        'feat: add provider abstraction',
        context.worktreePath,
      );
      return {
        success: true,
        message: 'Provider abstraction implemented',
        output: 'Created llm-provider.ts',
        durationMs: 1,
        commitHash,
      };
    }

    const upstreamPath = path.join(context.worktreePath, 'llm-provider.ts');
    this.downstreamSawUpstream = fs.existsSync(upstreamPath);
    if (!this.downstreamSawUpstream) {
      return {
        success: false,
        message: 'Missing integrated dependency: llm-provider.ts',
        output: 'Downstream task started from a stale repository base.',
        durationMs: 1,
      };
    }

    const upstream = fs.readFileSync(upstreamPath, 'utf8');
    if (!upstream.includes('interface LLMProvider')) {
      return {
        success: false,
        message: 'Integrated dependency content was not visible',
        durationMs: 1,
      };
    }

    fs.writeFileSync(
      path.join(context.worktreePath, 'anthropic-provider.ts'),
      "import type { LLMProvider } from './llm-provider.js';\nexport class AnthropicProvider implements LLMProvider { async generateStructured() { return {}; } }\n",
      'utf8',
    );
    const commitHash = await git.stageAndCommit(
      'feat: add anthropic provider',
      context.worktreePath,
    );
    return {
      success: true,
      message: 'Anthropic provider implemented on top of shared abstraction',
      output: 'Created anthropic-provider.ts using llm-provider.ts from TASK-UPSTREAM',
      durationMs: 1,
      commitHash,
    };
  }
}

describe('dependent task cumulative execution base', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-dependent-base');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService.exec(['init', '-b', 'main'], testRepoRoot);
    await gitService.exec(['config', 'user.name', 'TaskForge Dependency Test'], testRepoRoot);
    await gitService.exec(['config', 'user.email', 'dependency@taskforge.dev'], testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# dependency test\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);

    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
  });

  it('starts a dependent task from the cumulative branch containing its integrated dependency', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    const agent = new DependencyAwareAgent();
    registry.register(agent);

    const router: RoutingProvider = {
      id: 'dependency-test-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'medium',
        risk: 'medium',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canRead', 'canWrite'],
            objective: 'Implement the assigned dependency-aware change',
            preferredAgent: agent.id,
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'Deterministic dependency base regression test',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.execution.maxParallelTasks = 2;

    const graph = new TaskGraph();
    const upstream: Task = {
      id: 'TASK-UPSTREAM',
      goalId: 'goal-dependent-base',
      title: 'Create provider abstraction',
      description: 'Create provider abstraction',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Create llm-provider.ts',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['llm-provider.ts exists'],
        dependencies: [],
      },
      acceptanceCriteria: ['llm-provider.ts exists'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const downstream: Task = {
      id: 'TASK-DOWNSTREAM',
      goalId: 'goal-dependent-base',
      title: 'Add Anthropic provider',
      description: 'Implement Anthropic using the provider abstraction',
      type: 'implementation',
      status: 'accepted',
      dependencies: ['TASK-UPSTREAM'],
      contract: {
        objective: 'Implement Anthropic provider using llm-provider.ts',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['anthropic-provider.ts uses the shared abstraction'],
        dependencies: ['TASK-UPSTREAM'],
      },
      acceptanceCriteria: ['anthropic-provider.ts uses the shared abstraction'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    graph.addTask(upstream);
    graph.addTask(downstream);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService,
      worktreeManager,
    });

    const result = await orchestrator.run('Build a provider abstraction, then add Anthropic.', {
      preplannedGraph: graph,
    });

    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(2);
    expect(agent.downstreamSawUpstream).toBe(true);
    expect(result.integrationBranch).toBeDefined();

    const integratedFiles = await gitService.exec(
      ['ls-tree', '-r', '--name-only', result.integrationBranch!],
      testRepoRoot,
    );
    expect(integratedFiles).toContain('llm-provider.ts');
    expect(integratedFiles).toContain('anthropic-provider.ts');

    db.close();
  });
});
