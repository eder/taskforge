import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  type AgentAssignment,
  type AgentCapabilities,
  type AgentContext,
  type AgentResult,
  getDefaultConfig,
} from '@taskforge/shared';
import { type AgentAdapter, AgentRegistry } from '@taskforge/agents';
import { TaskForgeDatabase, EventRepository, TaskRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { describeRunFailures, formatRunFailureLines, recommendNextStep } from '../src/run-failure-report.js';
import { repairRun, planRunRepair } from '../src/run-repair.js';

/** Writes the file the task asks for. Counts how often an agent was started. */
class Writer implements AgentAdapter {
  readonly id = 'writer';
  readonly name = 'Writer';
  calls = 0;
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(_a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls += 1;
    fs.writeFileSync(path.join(context.worktreePath, 'feature.txt'), 'done\n');
    const git = new GitService(context.worktreePath);
    const commitHash = await git.stageAndCommit('feat: feature', context.worktreePath);
    return { success: true, message: 'Added feature.txt', durationMs: 1, commitHash };
  }
}

function writableTask(): Task {
  return {
    id: 'TASK-1',
    goalId: 'g',
    title: 'Add the feature',
    description: 'Add the feature',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Add feature.txt',
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['feature.txt exists'],
      dependencies: [],
      completionMode: 'mutation',
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// The check needs ./server/.env (a gitignored file) to exist in the checkout it runs in,
// exactly like a test suite that loads its configuration from a .env file.
const CHECK = `node -e "if(!require('fs').existsSync('server/.env')){console.error('RuntimeError: no LLM api_key configured');process.exit(2)}"`;

describe('preflight and tf fix: an environment problem is repaired once, not paid for', () => {
  const root = path.resolve(__dirname, '../test-sandbox-preflight');
  let git: GitService;
  let worktrees: WorktreeManager;
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'T'], root);
    await git.exec(['config', 'user.email', 't@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, '.gitignore'), 'server/.env\n.taskforge/\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
    await git.stageAndCommit('Initial commit', root);
    fs.writeFileSync(path.join(root, 'server/.env'), 'LLM_API_KEY=secret\n'); // exists for the developer only
    worktrees = new WorktreeManager(root, '.taskforge/worktrees', []); // no links: the real situation
    void sh;
  });
  afterEach(async () => {
    await worktrees.prune().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function build(links: string[] = []) {
    const db = new TaskForgeDatabase(':memory:');
    const writer = new Writer();
    const registry = new AgentRegistry(false);
    registry.register(writer);
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'x', preferredAgent: 'writer' }],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'test',
      }),
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.verification.commands = [CHECK];
    config.execution.worktreeLinks = links;
    const manager = new WorktreeManager(root, '.taskforge/worktrees', links);
    const orchestrator = new RunOrchestrator({
      repoRoot: root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: git,
      worktreeManager: manager,
    });
    return { db, writer, orchestrator };
  }

  it('stops before any agent runs when the checks cannot start here, and says how to repair it', async () => {
    const { db, writer, orchestrator } = build();
    const progress: string[] = [];

    const result = await orchestrator.run('Add feature.txt', {
      preplannedGraph: new TaskGraph([writableTask()]),
      onProgress: (m) => progress.push(m),
    });

    expect(result.status).toBe('failed');
    expect(writer.calls).toBe(0); // nothing was spent on agents
    expect(progress.join('\n')).toContain('Stopped before any agent started, so no tokens were spent');
    const events = new EventRepository(db).listByRun(result.runId);
    expect(events.some((e) => e.type === 'PREFLIGHT_BLOCKED')).toBe(true);

    const deps = { taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) };
    const lines = describeRunFailures(deps, result.runId);
    expect(lines[0].failureClass).toBe('environment');
    const step = recommendNextStep(lines, result.runId, undefined, root)!;
    expect(step.command).toBe(`tf fix ${result.runId}`);
    expect(step.why).toContain('server/.env');
    expect(step.runnable).toBe(true);
    expect(formatRunFailureLines(lines, result.runId, { repoRoot: root }).join('\n')).toContain('Next: tf fix');
    db.close();
  });

  it('tf fix links the .env and the continued run completes with the checks passing', async () => {
    const first = build();
    const failed = await first.orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([writableTask()]) });
    expect(failed.status).toBe('failed');
    expect(first.writer.calls).toBe(0);

    const deps = { taskRepo: new TaskRepository(first.db), eventRepo: new EventRepository(first.db) };
    expect(planRunRepair(deps, root, failed.runId).descriptions[0]).toContain('server/.env');
    const repair = await repairRun(deps, root, failed.runId);
    expect(repair.applied?.failed).toEqual([]);
    expect(repair.applied?.linksAdded).toEqual(['server/.env']);
    expect(fs.readFileSync(path.join(root, '.taskforge/config.yaml'), 'utf8')).toContain('server/.env');

    // The next command loads the config just written: model that with the link applied.
    const second = build(repair.applied!.linksAdded);
    const resumed = await second.orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([writableTask()]) });
    expect(resumed.status).toBe('completed');
    expect(second.writer.calls).toBe(1);
    first.db.close();
    second.db.close();
  });

  it('does nothing extra when the checks work, and can be turned off', async () => {
    fs.writeFileSync(path.join(root, 'server/.env'), 'x\n');
    const ok = build(['server/.env']);
    const progress: string[] = [];
    const result = await ok.orchestrator.run('Add feature.txt', {
      preplannedGraph: new TaskGraph([writableTask()]),
      onProgress: (m) => progress.push(m),
    });
    expect(result.status).toBe('completed');
    expect(progress.join('\n')).toContain("The project's checks run in this environment");
    ok.db.close();
  });
});
