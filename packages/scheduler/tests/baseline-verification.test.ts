import { describe, expect, it } from 'vitest';
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
import { TaskForgeDatabase, TaskRepository, EventRepository, RunRepository, VerificationRepository } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { describeRunFailures } from '../src/run-failure-report.js';
import { describeRunConfidence, formatRunConfidence } from '../src/run-confidence.js';
import { type GitSandbox, withGitSandbox } from './helpers/git-sandbox.js';

/** Writes feature.txt; when `breakSomething` it also introduces a new failure. */
function writer(state: { breakSomething: boolean; calls: number }): AgentAdapter {
  return {
    id: 'writer',
    name: 'Writer',
    detect: async () => true,
    capabilities: async (): Promise<AgentCapabilities> => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] }),
    execute: async (_a: AgentAssignment, context: AgentContext): Promise<AgentResult> => {
      state.calls += 1;
      fs.writeFileSync(path.join(context.worktreePath, 'feature.txt'), 'done\n');
      const flag = path.join(context.worktreePath, 'breaks.flag');
      if (state.breakSomething) fs.writeFileSync(flag, '');
      else fs.rmSync(flag, { force: true }); // continuing from kept work: undo the earlier mistake
      const commitHash = await new GitService(context.worktreePath).stageAndCommit('feat', context.worktreePath);
      return { success: true, message: 'done', durationMs: 1, commitHash };
    },
  };
}

function task(): Task {
  return {
    id: 'TASK-1',
    goalId: 'g',
    title: 'Add the feature',
    description: 'x',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: { objective: 'Add feature.txt', allowedScope: ['**'], forbiddenChanges: [], acceptanceCriteria: ['exists'], dependencies: [], completionMode: 'mutation' },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// A suite that already fails in two tests before anyone touches it (like a project whose
// tests need a service that is down), and fails in a third when breaks.flag exists.
const SUITE = `printf 'FAILED tests/old.py::test_a - boom\\nFAILED tests/old.py::test_b - boom\\n'; test -f breaks.flag && echo 'FAILED tests/new.py::test_c - boom'; exit 1`;

describe.concurrent('a project whose suite already has failures: only what the change adds counts', () => {
  function build(sandbox: GitSandbox, state: { breakSomething: boolean; calls: number }, suite = SUITE) {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(writer(state));
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
    config.verification.commands = [suite];
    config.verification.maxReworkCycles = 0;
    const orchestrator = new RunOrchestrator({
      repoRoot: sandbox.root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: sandbox.git,
      worktreeManager: sandbox.worktrees,
    });
    return { db, orchestrator };
  }

  it('completes when the change adds no failure, and says what was already failing', async () => {
    await withGitSandbox(async (sandbox) => {
      const state = { breakSomething: false, calls: 0 };
      const { db, orchestrator } = build(sandbox, state);
      const progress: string[] = [];

      const result = await orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([task()]), onProgress: (m) => progress.push(m) });

      expect(result.status).toBe('completed');
      expect(progress.join('\n')).toContain('2 failure(s) already exist on the unchanged code');
      const metadata = JSON.parse(new RunRepository(db).get(result.runId)!.metadataJson!);
      expect(metadata.verificationBaseline[SUITE]).toEqual({
        failed: true,
        signatures: ['FAILED tests/old.py::test_a', 'FAILED tests/old.py::test_b'],
      });
      const confidence = describeRunConfidence(
        { taskRepo: new TaskRepository(db), verificationRepo: new VerificationRepository(db), eventRepo: new EventRepository(db) },
        result.runId,
      );
      expect(confidence.headline).toBe('verified');
      expect(formatRunConfidence(confidence).join('\n')).toContain('no new failures');
      db.close();
    });
  });

  it('blocks when the change adds a failure, and shows the agent only the new one', async () => {
    await withGitSandbox(async (sandbox) => {
      const state = { breakSomething: true, calls: 0 };
      const { db, orchestrator } = build(sandbox, state);

      const result = await orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([task()]) });

      expect(result.status).toBe('failed');
      const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) }, result.runId);
      const evidence = lines.map((l) => l.evidence ?? '').join('\n');
      expect(evidence).toContain('New failures compared with before the change (2 already failing are ignored)');
      expect(evidence).toContain('- FAILED tests/new.py::test_c');
      expect(evidence).not.toMatch(/- FAILED tests\/old\.py/);
      expect(lines.some((l) => l.keptBranch)).toBe(true);
      db.close();
    });
  });

  it('keeps judging by the first measurement when the run is resumed', async () => {
    await withGitSandbox(async (sandbox) => {
      const state = { breakSomething: true, calls: 0 };
      const { db, orchestrator } = build(sandbox, state);
      const first = await orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([task()]) });
      expect(first.status).toBe('failed');

      state.breakSomething = false;
      const resumed = await orchestrator.resume(first.runId, {});

      expect(resumed.status).toBe('completed');
      db.close();
    });
  });

  const LIVE_SERVICE_SUITE = `echo "FAILED tests/test_live.py::test_voice - ConnectionRefusedError: [Errno 61] Connect call failed ('127.0.0.1', 8765)"; test -f breaks.flag && echo 'FAILED tests/new.py::test_c - boom'; echo '1 failed, 3 passed'; exit 1`;
  const DIES_AT_COLLECTION = `echo "ERROR test_a.py - ConnectionRefusedError: [Errno 61] Connect call failed"; echo "!!!! Interrupted: 1 error during collection !!!!"; exit 2`;
  const UNREADABLE = `echo 'Connection refused' >&2; exit 1`;

  it('does not stop for tests that need a service which is not running: the suite ran, so it is a starting point', async () => {
    await withGitSandbox(async (sandbox) => {
      const state = { breakSomething: false, calls: 0 };
      const { db, orchestrator } = build(sandbox, state, LIVE_SERVICE_SUITE);
      const progress: string[] = [];

      const result = await orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([task()]), onProgress: (m) => progress.push(m) });

      expect(result.status).toBe('completed');
      expect(state.calls).toBe(1);
      const text = progress.join('\n');
      expect(text).toContain('already fail here because they need something this environment does not have (for example a service on port 8765)');
      expect(text).toContain('a test that talks to a running service tests that service, not the isolated copy');
      const metadata = JSON.parse(new RunRepository(db).get(result.runId)!.metadataJson!);
      expect(metadata.verificationBaseline[LIVE_SERVICE_SUITE].environmental).toBe(true);
      db.close();
    });
  });

  it('still blocks a change that adds a failure on top of those', async () => {
    await withGitSandbox(async (sandbox) => {
      const state = { breakSomething: true, calls: 0 };
      const { db, orchestrator } = build(sandbox, state, LIVE_SERVICE_SUITE);
      const result = await orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([task()]) });
      expect(result.status).toBe('failed');
      const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) }, result.runId);
      expect(lines.map((l) => l.evidence ?? '').join('\n')).toContain('- FAILED tests/new.py::test_c');
      db.close();
    });
  });

  it('still stops before any agent when the suite proves nothing: it dies at collection, or its output cannot be read', async () => {
    await withGitSandbox(async (sandbox) => {
      for (const suite of [DIES_AT_COLLECTION, UNREADABLE]) {
        const state = { breakSomething: false, calls: 0 };
        const { db, orchestrator } = build(sandbox, state, suite);
        const result = await orchestrator.run('Add feature.txt', { preplannedGraph: new TaskGraph([task()]) });
        expect(result.status).toBe('failed');
        expect(state.calls).toBe(0);
        db.close();
      }
    });
  });
});
