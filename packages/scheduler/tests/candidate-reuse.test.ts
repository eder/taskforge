import { describe, it, expect } from 'vitest';
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
import { TaskForgeDatabase, EventRepository, RunRepository } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { type GitSandbox, withGitSandbox } from './helpers/git-sandbox.js';

class CountingWriter implements AgentAdapter {
  readonly id = 'writer';
  readonly name = 'Writer';
  public calls = 0;
  /** What each call found in its worktree before writing. */
  public sawExisting: boolean[] = [];
  constructor(private contentFor: (call: number, existing: boolean) => string = () => 'done\n') {}
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(_a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls++;
    const file = path.join(context.worktreePath, 'feature.txt');
    const existing = fs.existsSync(file);
    this.sawExisting.push(existing);
    fs.writeFileSync(file, this.contentFor(this.calls, existing));
    const git = new GitService(context.worktreePath);
    const commitHash = await git.stageAndCommit(`feat: attempt ${this.calls}`, context.worktreePath);
    return { success: true, message: 'ok', output: 'implemented', durationMs: 1, commitHash };
  }
}

function featureTask(): Task {
  return {
    id: 'TASK-FEATURE',
    goalId: 'g',
    title: 'Add feature',
    description: 'Add feature',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Write feature.txt',
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

describe.concurrent('blocked work is kept and reused by tf resume', () => {
  /** Same repo and database for both "processes", like two tf invocations. */
  function orchestrator(
    sandbox: GitSandbox,
    db: TaskForgeDatabase,
    agent: AgentAdapter,
    verificationCommands: string[],
  ) {
    const registry = new AgentRegistry(false);
    registry.register(agent);
    const router: RoutingProvider = {
      id: 'r',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'x', preferredAgent: agent.id }],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'deterministic',
      }),
    };
    const config = getDefaultConfig();
    config.verification.commands = verificationCommands;
    config.verification.review = false;
    config.verification.preflight = false;
    return new RunOrchestrator({
      repoRoot: sandbox.root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: sandbox.git,
      worktreeManager: sandbox.worktrees,
    });
  }

  const BROKEN_VERIFICATION =
    'echo "FAILED t.py::t - async def functions are not natively supported." >&2; exit 2';

  it('keeps the agent work on a named branch when verification is misconfigured, and says so', async () => {
    await withGitSandbox(async (sandbox) => {
      const db = new TaskForgeDatabase(':memory:');
      const agent = new CountingWriter();
      const progress: string[] = [];
      const result = await orchestrator(sandbox, db, agent, [BROKEN_VERIFICATION]).run('Add feature', {
        preplannedGraph: new TaskGraph([featureTask()]),
        onProgress: (m) => progress.push(m),
      });

      expect(result.status).toBe('failed');
      expect(agent.calls).toBe(1);

      const branch = `taskforge/candidate/${result.runId.replace(/^run-/, '')}/TASK-FEATURE`;
      expect(await sandbox.git.branchExists(branch)).toBe(true);
      expect(await sandbox.git.exec(['show', `${branch}:feature.txt`], sandbox.root)).toContain('done');
      expect(progress.join('\n')).toContain(`Work kept on branch ${branch}`);
      expect(progress.join('\n')).toContain('without calling any agent');

      const events = new EventRepository(db).listByRun(result.runId);
      expect(events.some((e) => e.type === 'TASK_CANDIDATE_PRESERVED')).toBe(true);
      db.close();
    });
  });

  it('after the config is fixed, resume finishes the task WITHOUT calling any agent', async () => {
    await withGitSandbox(async (sandbox) => {
      const db = new TaskForgeDatabase(':memory:');
      const firstAgent = new CountingWriter();
      const first = await orchestrator(sandbox, db, firstAgent, [BROKEN_VERIFICATION]).run('Add feature', {
        preplannedGraph: new TaskGraph([featureTask()]),
      });
      expect(first.status).toBe('failed');

      const secondAgent = new CountingWriter();
      const progress: string[] = [];
      const resumed = await orchestrator(sandbox, db, secondAgent, ['true']).resume(first.runId, {
        onProgress: (m) => progress.push(m),
      });

      expect(resumed.status).toBe('completed');
      expect(secondAgent.calls).toBe(0);
      expect(progress.join('\n')).toContain('Work from an earlier attempt is kept for TASK-FEATURE');
      expect(progress.join('\n')).toContain('no agent call');
      const files = await sandbox.git.exec(['ls-tree', '-r', '--name-only', resumed.integrationBranch!], sandbox.root);
      expect(files).toContain('feature.txt');

      const metadata = JSON.parse(new RunRepository(db).get(first.runId)!.metadataJson!);
      expect(Object.keys(metadata.candidates ?? {})).toEqual([]);
      db.close();
    });
  });

  it('a candidate that fails the check again stays blocked, still kept, with no agent call', async () => {
    await withGitSandbox(async (sandbox) => {
      const db = new TaskForgeDatabase(':memory:');
      const first = await orchestrator(sandbox, db, new CountingWriter(), [BROKEN_VERIFICATION]).run('Add feature', {
        preplannedGraph: new TaskGraph([featureTask()]),
      });
      const agent = new CountingWriter();
      const resumed = await orchestrator(sandbox, db, agent, [BROKEN_VERIFICATION]).resume(first.runId);
      expect(resumed.status).toBe('failed');
      expect(agent.calls).toBe(0);
      expect(await sandbox.git.branchExists(`taskforge/candidate/${first.runId.replace(/^run-/, '')}/TASK-FEATURE`)).toBe(true);
      db.close();
    });
  });

  it('--fresh discards the kept work and starts the task over with an agent', async () => {
    await withGitSandbox(async (sandbox) => {
      const db = new TaskForgeDatabase(':memory:');
      const first = await orchestrator(sandbox, db, new CountingWriter(), [BROKEN_VERIFICATION]).run('Add feature', {
        preplannedGraph: new TaskGraph([featureTask()]),
      });
      const agent = new CountingWriter();
      const resumed = await orchestrator(sandbox, db, agent, ['true']).resume(first.runId, { freshStart: true });
      expect(resumed.status).toBe('completed');
      expect(agent.calls).toBe(1);
      db.close();
    });
  });

  it('when the work itself was wrong, the agent continues from the kept commit instead of from scratch', async () => {
    await withGitSandbox(async (sandbox) => {
      const db = new TaskForgeDatabase(':memory:');
      const check = 'grep -q DONE feature.txt';
      const firstAgent = new CountingWriter(() => 'not yet\n');
      const first = await orchestrator(sandbox, db, firstAgent, [check]).run('Add feature', {
        preplannedGraph: new TaskGraph([featureTask()]),
      });
      expect(first.status).toBe('failed');
      expect(firstAgent.sawExisting[0]).toBe(false);

      const secondAgent = new CountingWriter((_call, existing) => (existing ? 'DONE\n' : 'not yet\n'));
      const resumed = await orchestrator(sandbox, db, secondAgent, [check]).resume(first.runId);

      expect(secondAgent.sawExisting[0]).toBe(true);
      expect(resumed.status).toBe('completed');
      db.close();
    });
  });

  describe.concurrent('team (pair) execution, the path of the reported run', () => {
    class Reviewer implements AgentAdapter {
      readonly id = 'checker';
      readonly name = 'Checker';
      public calls = 0;
      async detect() {
        return true;
      }
      async capabilities(): Promise<AgentCapabilities> {
        return { canRead: true, canWrite: false, canExecute: true, languages: [], tools: [] };
      }
      async execute(_a: AgentAssignment, _c: AgentContext): Promise<AgentResult> {
        this.calls++;
        return { success: true, message: 'ok', output: 'Reviewed: no blocking findings.', durationMs: 1 };
      }
    }

    function pairOrchestrator(
      sandbox: GitSandbox,
      db: TaskForgeDatabase,
      writer: AgentAdapter,
      reviewer: AgentAdapter,
      commands: string[],
    ) {
      const registry = new AgentRegistry(false);
      registry.register(writer);
      registry.register(reviewer);
      const router: RoutingProvider = {
        id: 'pair-router',
        route: async () => ({
          strategy: 'pair',
          complexity: 'medium',
          risk: 'medium',
          uncertainty: 'low',
          teamSize: 2,
          roles: [
            { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'implement', preferredAgent: writer.id },
            { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'review', preferredAgent: reviewer.id },
          ],
          communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
          reason: 'deterministic',
        }),
      };
      const config = getDefaultConfig();
      config.verification.commands = commands;
      config.verification.review = false;
      config.verification.preflight = false;
      return new RunOrchestrator({
        repoRoot: sandbox.root,
        config,
        database: db,
        agentRegistry: registry,
        router,
        gitService: sandbox.git,
        worktreeManager: sandbox.worktrees,
      });
    }

    it('keeps the team result when verification is misconfigured and resume re-checks it with no agent call', async () => {
      await withGitSandbox(async (sandbox) => {
        const db = new TaskForgeDatabase(':memory:');
        const writer = new CountingWriter();
        const reviewer = new Reviewer();
        const progress: string[] = [];
        const first = await pairOrchestrator(sandbox, db, writer, reviewer, [BROKEN_VERIFICATION]).run('Add feature', {
          preplannedGraph: new TaskGraph([featureTask()]),
          onProgress: (m) => progress.push(m),
        });

        expect(first.status).toBe('failed');
        expect(progress.join('\n')).toMatch(/Collaborative (task BLOCKED|verification failed)/);
        const branch = `taskforge/candidate/${first.runId.replace(/^run-/, '')}/TASK-FEATURE`;
        expect(await sandbox.git.branchExists(branch)).toBe(true);
        const callsAfterFirstRun = { writer: writer.calls, reviewer: reviewer.calls };
        expect(callsAfterFirstRun.writer).toBeGreaterThan(0);

        const writer2 = new CountingWriter();
        const reviewer2 = new Reviewer();
        const resumed = await pairOrchestrator(sandbox, db, writer2, reviewer2, ['true']).resume(first.runId);

        expect(resumed.status).toBe('completed');
        expect(writer2.calls).toBe(0);
        expect(reviewer2.calls).toBe(0);
        const files = await sandbox.git.exec(['ls-tree', '-r', '--name-only', resumed.integrationBranch!], sandbox.root);
        expect(files).toContain('feature.txt');
        db.close();
      });
    });
  });
});

