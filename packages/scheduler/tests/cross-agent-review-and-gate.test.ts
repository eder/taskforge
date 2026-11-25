import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskGraph, type Task } from '@taskforge/core';
import {
  AgentRegistry,
  type AgentAdapter,
  type AgentAssignment,
  type AgentCapabilities,
  type AgentContext,
  type AgentResult,
} from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { StaticRoutingProvider } from '@taskforge/router';
import { getDefaultConfig } from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';
import { CompletionGate } from '../src/completion-gate.js';
import { RunOrchestrator } from '../src/run-orchestrator.js';

class NamedRecordingAdapter implements AgentAdapter {
  public executedTasks: string[] = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly onExec: (taskId: string, wtPath: string, mutationAllowed: boolean) => string,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['edit'],
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.executedTasks.push(assignment.taskId);
    const out = this.onExec(assignment.taskId, context.worktreePath, Boolean(context.mutationAllowed));
    return { success: true, message: out, output: out, durationMs: 10 };
  }
}

describe('Cross-agent review assignment & Portuguese/English review blocking gate', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('rejects review tasks in CompletionGate when reviewer outputs Portuguese "Revisão bloqueada" or "defeitos críticos"', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-gate-pt-'));
    tempDirs.push(repoRoot);
    execSync('git init -b main', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git config user.email "test@taskforge.local"', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git config user.name "TaskForge Test"', { cwd: repoRoot, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoRoot, 'a.ts'), 'export const a = 1;\n', 'utf8');
    execSync('git add -A && git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' });

    const gate = new CompletionGate(new GitService(repoRoot));
    const reviewTask: Task = {
      id: 'TASK-02',
      goalId: 'goal-1',
      title: 'Verification and Review',
      description: 'Review TASK-01',
      type: 'review',
      status: 'running',
      dependencies: ['TASK-01'],
      contract: {
        objective: 'Review TASK-01',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Implementation approved'],
        dependencies: ['TASK-01'],
        completionMode: 'review',
      },
      acceptanceCriteria: ['Implementation approved'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const ptBlocked = await gate.evaluate({
      task: reviewTask,
      agentResult: {
        success: true,
        output: 'Revisão bloqueada: encontrei 2 defeitos críticos em TASK-01.',
        durationMs: 10,
      },
      worktreePath: repoRoot,
    });
    expect(ptBlocked.accepted).toBe(false);
    expect(ptBlocked.failureReason).toBe('ACCEPTANCE_NOT_MET');

    const enBlocked = await gate.evaluate({
      task: reviewTask,
      agentResult: {
        success: true,
        output: 'Review blocked: found 1 critical defect in edge-case handling.',
        durationMs: 10,
      },
      worktreePath: repoRoot,
    });
    expect(enBlocked.accepted).toBe(false);
    expect(enBlocked.failureReason).toBe('ACCEPTANCE_NOT_MET');

    const rawToolJson = await gate.evaluate({
      task: reviewTask,
      agentResult: {
        success: true,
        output: '```json\n{\n  "name": "search_files",\n  "arguments": { "query": "TASK-01" }\n}\n```',
        durationMs: 10,
      },
      worktreePath: repoRoot,
    });
    expect(rawToolJson.accepted).toBe(false);
    expect(rawToolJson.failureReason).toBe('EMPTY_PROVIDER_RESULT');
    expect(rawToolJson.evidence.explanation).toContain('unexecuted tool-call JSON');
  });

  it('assigns an independent reviewer agent (not the implementer of the prerequisite task) when multiple healthy agents exist', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cross-rev-'));
    tempDirs.push(repoRoot);
    execSync('git init -b main', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git config user.email "test@taskforge.local"', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git config user.name "TaskForge Test"', { cwd: repoRoot, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# demo\n', 'utf8');
    execSync('git add -A && git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' });
    const db = new TaskForgeDatabase(':memory:');
    const implTask: Task = {
      id: 'TASK-01',
      goalId: 'g1',
      title: 'Update documentation',
      description: 'Add setup notes to README.md',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Update README.md',
        allowedScope: ['README.md'],
        forbiddenChanges: [],
        acceptanceCriteria: ['README updated'],
        dependencies: [],
        completionMode: 'mutation',
      },
      acceptanceCriteria: ['README updated'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const revTask: Task = {
      id: 'TASK-02',
      goalId: 'g1',
      title: 'Review documentation changes',
      description: 'Independently review TASK-01',
      type: 'review',
      status: 'accepted',
      dependencies: ['TASK-01'],
      contract: {
        objective: 'Review README changes',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Review approved'],
        dependencies: ['TASK-01'],
        completionMode: 'review',
      },
      acceptanceCriteria: ['Review approved'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const graph = new TaskGraph([implTask, revTask]);

    const codex = new NamedRecordingAdapter('codex', 'Codex CLI', (_t, wt, mut) => {
      if (mut) fs.writeFileSync(path.join(wt, 'README.md'), '# demo\n\nUpdated by codex.\n', 'utf8');
      return 'Updated README.md cleanly.';
    });
    const agy = new NamedRecordingAdapter('agy', 'Google Antigravity', () => {
      return 'REVIEW_VERDICT: APPROVED — documentation update is clear and accurate.';
    });
    const registry = new AgentRegistry(false);
    registry.register(codex);
    registry.register(agy);

    const config = getDefaultConfig();
    config.planner.agent = 'codex';
    config.collaboration.maxAgentsPerTask = 1;
    config.verification.preflight = false;
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const progressLines: string[] = [];
    const orchestrator = new RunOrchestrator({
      repoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: new StaticRoutingProvider(),
      gitService: new GitService(repoRoot),
    });

    const res = await orchestrator.run('Update README and review', {
      runId: 'run-cross-rev-1',
      preplannedGraph: graph,
      onProgress: (m) => progressLines.push(m),
    });
    expect(res.status).toBe('completed');
    expect(codex.executedTasks).toEqual(['TASK-01']);
    expect(agy.executedTasks).toEqual(['TASK-02']);
    expect(progressLines.some((l) => l.includes('independent reviewer agy'))).toBe(true);
    db.close();
  });
});
