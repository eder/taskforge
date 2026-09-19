import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { TaskGraph, Task } from '@taskforge/core';
import { TuiDashboard, InteractiveShell } from '@taskforge/conversation';
import { GitHubWorkflowService } from '@taskforge/integration';
import { DockerWorkerAdapter, SshWorkerAdapter } from '@taskforge/agents';
import { TelemetryCollector } from '@taskforge/telemetry';

describe('Phases 20-22: Advanced UX (TUI), GitHub Workflow & Remote Workers', () => {
  let db: TaskForgeDatabase;
  let testRepoRoot: string;

  beforeEach(() => {
    db = new TaskForgeDatabase(':memory:');
    testRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-p20-22-'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  describe('Phase 20: Advanced UX (TUI Dashboard)', () => {
    it('renders visual task graph with statuses and dependency hierarchy', () => {
      const task1: Task = {
        id: 'TASK-1',
        goalId: 'goal-1',
        title: 'Database Schema Migration',
        description: 'Migrate DB',
        type: 'implementation',
        status: 'integrated',
        dependencies: [],
        contract: {
          objective: 'Run migration',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Done'],
          dependencies: [],
        },
        acceptanceCriteria: ['Done'],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const task2: Task = {
        id: 'TASK-2',
        goalId: 'goal-1',
        title: 'Backend API Service',
        description: 'API endpoint',
        type: 'implementation',
        status: 'running',
        dependencies: ['TASK-1'],
        contract: {
          objective: 'API endpoint',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Done'],
          dependencies: ['TASK-1'],
        },
        acceptanceCriteria: ['Done'],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const graph = new TaskGraph([task1, task2]);
      const renderedGraph = TuiDashboard.renderTaskGraph(graph);

      expect(renderedGraph).toContain('Task Graph (DAG)');
      expect(renderedGraph).toContain('TASK-1');
      expect(renderedGraph).toContain('TASK-2');
      expect(renderedGraph).toContain('INTEGRATED');
      expect(renderedGraph).toContain('RUNNING');
      expect(renderedGraph).toContain('depends on: [TASK-1]');
    });

    it('renders full dashboard snapshot including telemetry and agent matrix', () => {
      const dashboard = TuiDashboard.render({
        repoRoot: testRepoRoot,
        branch: 'main',
        headCommit: 'abcdef1234567',
        isClean: true,
        agents: [
          { id: 'claude', name: 'Claude Code', ready: true },
          { id: 'codex', name: 'Codex CLI', ready: false },
        ],
        runStats: {
          runId: 'run-123',
          durationMs: 8200,
          totalCostUsd: 0.0452,
          tasksCount: 3,
          tasksCompleted: 3,
          tasksFailed: 0,
          reworkCount: 0,
          escalationsCount: 0,
          firstPassRate: 1.0,
        },
        worktrees: [
          { id: 'wt-TASK-1', branch: 'taskforge/TASK-1', agentId: 'claude', status: 'active' },
        ],
      });

      expect(dashboard).toContain('TASKFORGE CONTROL PLANE');
      expect(dashboard).toContain('Available Agents');
      expect(dashboard).toContain('Claude Code');
      expect(dashboard).toContain('Isolated Worktrees');
      expect(dashboard).toContain('Metrics & Telemetry');
      expect(dashboard).toContain('8.2s');
    });

    it('handles /dash command in InteractiveShell', async () => {
      const shell = new InteractiveShell({
        repoRoot: testRepoRoot,
        database: db,
      });

      const response = await shell.handleInput('/dash');
      expect(response).toContain('TASKFORGE CONTROL PLANE');
      expect(response).toContain('Available Agents');
    });
  });

  describe('Phase 21: GitHub Workflow Integration', () => {
    it('generates structured GitHub Flavored Markdown PR summary with audit evidence', () => {
      const runId = 'run-gh-test';
      const goalId = 'goal-gh-test';

      db.prepare(
        `INSERT INTO runs (id, goal_id, status, created_at) VALUES (?, ?, 'completed', ?)`,
      ).run(runId, goalId, new Date().toISOString());

      db.prepare(
        `INSERT INTO goals (id, description, repository, created_at) VALUES (?, 'Implement OAuth login', ?, ?)`,
      ).run(goalId, testRepoRoot, new Date().toISOString());

      db.prepare(
        `INSERT INTO tasks (id, run_id, goal_id, title, description, type, status, rework_count, created_at, updated_at)
         VALUES ('TASK-01', ?, ?, 'OAuth Backend', 'Desc', 'implementation', 'integrated', 0, ?, ?)`,
      ).run(runId, goalId, new Date().toISOString(), new Date().toISOString());

      const telemetry = new TelemetryCollector(db);
      telemetry.recordTaskTokens({
        runId,
        taskId: 'TASK-01',
        agentId: 'claude',
        modelName: 'claude-3-7-sonnet',
        inputTokens: 15_000,
        outputTokens: 3_000,
      });

      telemetry.recordRunMetrics({
        runId,
        durationMs: 12500,
        tasksCount: 1,
        tasksCompleted: 1,
        tasksFailed: 0,
        reworkCount: 0,
        escalationsCount: 0,
      });

      const ghService = new GitHubWorkflowService(db, testRepoRoot);
      const summary = ghService.generatePullRequestSummary(runId);

      expect(summary).toContain('TaskForge Automated Run Summary');
      expect(summary).toContain('Implement OAuth login');
      expect(summary).toContain('TASK-01');
      expect(summary).toContain('Evidências de Qualidade & Verificação');
      expect(summary).toContain('Testes Automatizados:** PASS');
      expect(summary).toContain('Telemetria e Uso de Recursos');
      expect(summary).toContain('Tokens processados');
    });

    it('creates pull request or provides fallback summary if gh is unavailable', async () => {
      const ghService = new GitHubWorkflowService(db, testRepoRoot);
      const runId = 'run-pr-fallback';

      db.prepare(`INSERT INTO runs (id, status, created_at) VALUES (?, 'completed', ?)`).run(
        runId,
        new Date().toISOString(),
      );

      const result = await ghService.createPullRequest({
        runId,
        targetBranch: 'main',
      });

      expect(result.summary).toBeDefined();
      expect(result.commandUsed).toContain('gh pr create');
      expect(result.message).toBeDefined();
    });
  });

  describe('Phase 22: Remote Workers', () => {
    it('initializes DockerWorkerAdapter with container parameters and capabilities', async () => {
      const dockerWorker = new DockerWorkerAdapter('docker-worker', 'Docker Alpine Worker', {
        image: 'alpine:latest',
        memoryLimit: '1g',
        network: 'none',
      });

      expect(dockerWorker.id).toBe('docker-worker');
      expect(dockerWorker.name).toBe('Docker Alpine Worker');

      const caps = await dockerWorker.capabilities();
      expect(caps.canExecute).toBe(true);
      expect(caps.canWrite).toBe(true);
      expect(caps.tools).toContain('docker');
    });

    it('initializes SshWorkerAdapter with remote parameters and capabilities', async () => {
      const sshWorker = new SshWorkerAdapter('remote-ssh', 'Remote SSH Runner', {
        host: 'worker.internal',
        user: 'taskforge',
        port: 2222,
      });

      expect(sshWorker.id).toBe('remote-ssh');
      const caps = await sshWorker.capabilities();
      expect(caps.canExecute).toBe(true);
      expect(caps.tools).toContain('ssh');
    });
  });
});
