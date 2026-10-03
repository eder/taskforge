import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDefaultConfig } from '@taskforge/shared';
import { AgentRegistry, FakeAgent, type AgentAdapter } from '@taskforge/agents';
import { TaskForgeDatabase, RunRepository, EventRepository, TaskRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator, describeRunFailures } from '@taskforge/scheduler';
import { DeliveryService } from '@taskforge/integration';
import { TelemetryCollector } from '@taskforge/telemetry';

const exec = promisify(execFile);

/**
 * `tf selftest`: proves the whole pipeline on YOUR machine with YOUR agents, on a tiny
 * throwaway project, before anything real is at stake. It walks the path every real
 * run takes (isolated worktree, agent edit, verification, integration, delivery,
 * apply, undo) and says which stage failed and what to do about it. Everything that
 * touches the outside world is injected, so the same flow runs in tests with a fake agent.
 */
export interface SelftestDeps {
  /** Use the in-process fake agent: checks the pipeline without calling a provider. */
  fake: boolean;
  /** The agent to use; default: the first ready one. */
  agentId?: string;
  /** Token cap for the run (a real agent reads the project, so keep it generous but bounded). */
  budget: number;
  /** Keep the sandbox for inspection. */
  keep: boolean;
  /** Agents that are installed and ready (real mode). */
  readyAgents(): Promise<Array<{ id: string; name: string }>>;
  /** Builds the adapter for a ready agent id (real mode). */
  createAgent(id: string): AgentAdapter | undefined;
  log(line: string): void;
}

export interface SelftestStage {
  name: string;
  state: 'passed' | 'failed' | 'skipped';
  detail?: string;
  /** What to do when it failed. */
  hint?: string;
  ms?: number;
}

export interface SelftestResult {
  passed: boolean;
  stages: SelftestStage[];
  sandbox?: string;
  agent?: string;
}

const GREET_TEST = `const test = require('node:test');
const assert = require('node:assert');
const { greet } = require('./greet.js');

test('greets by name', () => {
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
`;

const GREET_IMPL = `function greet(name) {
  return 'Hello, ' + name + '!';
}
module.exports = { greet };
`;

const OBJECTIVE =
  "Create greet.js exporting a function greet(name) that returns 'Hello, <name>!' so that `node --test` passes. Do not modify greet.test.js.";

function selftestTask(): Task {
  return {
    id: 'SELFTEST-1',
    goalId: 'selftest',
    title: 'Create greet.js',
    description: OBJECTIVE,
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: OBJECTIVE,
      allowedScope: ['greet.js'],
      forbiddenChanges: ['greet.test.js'],
      acceptanceCriteria: ['greet.js exists and `node --test` passes'],
      dependencies: [],
      completionMode: 'mutation',
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** One sentence per likely cause, so a failure says what to try. */
function hintFor(stage: string, message: string): string | undefined {
  const text = message.toLowerCase();
  if (stage === 'agent') {
    return 'Install and sign in to Claude Code (`claude`), Codex (`codex`) or Antigravity (`agy`), then run `tf doctor`. Use `tf selftest --fake` to check the pipeline without an agent.';
  }
  if (/auth|login|sign in|oauth|api key|credentials|expired/.test(text)) {
    return 'The agent is not signed in or its login expired: open that CLI once, sign in, and run the self-test again.';
  }
  if (/quota|rate limit|usage limit/.test(text)) return 'The agent reports a quota or rate limit; try another agent with --agent.';
  if (/permission|denied/.test(text)) return 'The agent was refused a permission it needed. `tf inspect` shows which; see "Permissions" in docs/usage.md.';
  if (stage === 'agent run') return 'Run `tf inspect last` for the full record of what the agent did and why the run stopped.';
  return undefined;
}

export async function runSelftest(deps: SelftestDeps): Promise<SelftestResult> {
  const { log } = deps;
  const stages: SelftestStage[] = [];
  let sandbox: string | undefined;
  let db: TaskForgeDatabase | undefined;
  let worktrees: WorktreeManager | undefined;
  let failed = false;

  const stage = async <T>(name: string, work: () => Promise<T>, hint?: (e: Error) => string | undefined): Promise<T | undefined> => {
    if (failed) {
      stages.push({ name, state: 'skipped' });
      log(`  – ${name}: not run (an earlier stage failed)`);
      return undefined;
    }
    const started = Date.now();
    log(`  ▸ ${name}...`);
    try {
      const value = await work();
      const ms = Date.now() - started;
      stages.push({ name, state: 'passed', ms });
      log(`  ✔ ${name} (${(ms / 1000).toFixed(1)}s)`);
      return value;
    } catch (err) {
      failed = true;
      const message = (err as Error).message.split('\n')[0];
      const h = hint?.(err as Error) ?? hintFor(name, (err as Error).message);
      stages.push({ name, state: 'failed', detail: message, hint: h, ms: Date.now() - started });
      log(`  ✖ ${name}: ${message}`);
      if (h) log(`    → ${h}`);
      return undefined;
    }
  };

  log('TaskForge self-test: the whole pipeline on a throwaway project.\n');

  // 1. Which agent.
  let agent: AgentAdapter | undefined;
  await stage('agent', async () => {
    if (deps.fake) {
      agent = new FakeAgent('selftest-fake', 'Fake agent (no provider is called)', [
        { writeFile: { path: 'greet.js', content: GREET_IMPL }, gitCommitMessage: 'feat(SELFTEST-1): create greet.js' },
      ]);
      return;
    }
    const ready = await deps.readyAgents();
    const chosen = deps.agentId ? ready.find((r) => r.id === deps.agentId) : ready[0];
    if (!chosen) {
      throw new Error(
        deps.agentId ? `Agent "${deps.agentId}" is not installed and ready.` : 'No coding agent is installed and ready.',
      );
    }
    agent = deps.createAgent(chosen.id);
    if (!agent) throw new Error(`Could not start the ${chosen.id} adapter.`);
    log(`    using ${chosen.name} (cap ${deps.budget.toLocaleString('en-US')} tokens)`);
  });

  // 2. A throwaway project with one failing test.
  const repo = await stage('sandbox project', async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-selftest-'));
    fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'selftest', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
    fs.writeFileSync(path.join(sandbox, 'greet.test.js'), GREET_TEST);
    fs.writeFileSync(path.join(sandbox, '.gitignore'), '.taskforge/\n');
    const git = new GitService(sandbox);
    await git.exec(['init', '-b', 'main'], sandbox);
    await git.exec(['config', 'user.name', 'TaskForge selftest'], sandbox);
    await git.exec(['config', 'user.email', 'selftest@taskforge.invalid'], sandbox);
    await git.stageAndCommit('Initial commit: a test with no implementation', sandbox);
    return sandbox;
  });

  // 3. The agent does the work, verified by the project's own command.
  const summary = await stage('agent run (isolated worktree, edit, verification, integration)', async () => {
    const root = repo!;
    const registry = new AgentRegistry(false);
    registry.register(agent!);
    const router: RoutingProvider = {
      id: 'selftest-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [{ role: 'implementer', requiredCapabilities: ['canWrite'], objective: OBJECTIVE, preferredAgent: agent!.id }],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'self-test',
        source: 'static',
      }),
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.verification.commands = ['node --test'];
    config.verification.maxReworkCycles = 1;
    config.collaboration.maxAgentsPerTask = 1;

    db = new TaskForgeDatabase(':memory:');
    const git = new GitService(root);
    worktrees = new WorktreeManager(root, '.taskforge/worktrees');
    const orchestrator = new RunOrchestrator({ repoRoot: root, config, database: db, agentRegistry: registry, router, gitService: git, worktreeManager: worktrees });
    const progress: string[] = [];
    const result = await orchestrator.run('Self-test: create greet.js', {
      preplannedGraph: new TaskGraph([selftestTask()]),
      tokenBudget: deps.budget,
      onProgress: (m) => progress.push(m),
    });
    if (result.status !== 'completed') {
      // The run's own summary ("completed=0, failed=1") says nothing; the recorded reasons do.
      const recorded = describeRunFailures(
        { taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) },
        result.runId,
      )
        .filter((l) => l.kind !== 'not_started')
        .map((l) => l.evidence ?? l.reason ?? '')
        .join(' | ')
        .replace(/\s+/g, ' ')
        .trim();
      const lastProgress = progress.filter((m) => /fail|block|error|denied|✗/i.test(m)).slice(-1)[0];
      throw new Error(`The run did not complete: ${recorded || lastProgress || result.error || `it ended ${result.status}`}`);
    }
    if (!result.integrationBranch) throw new Error('The run completed but produced no integration branch.');
    return { runId: result.runId, branch: result.integrationBranch, git, root };
  });

  // 4. Our own check of the result, independent of the run's verification.
  await stage('independent check of the delivered branch', async () => {
    const { branch, root } = summary!;
    const probe = path.join(root, '.taskforge', 'selftest-probe');
    await exec('git', ['worktree', 'add', '--detach', probe, branch], { cwd: root });
    try {
      await exec('node', ['--test'], { cwd: probe, timeout: 60_000 });
    } catch (err) {
      throw new Error(`\`node --test\` fails on the delivered branch: ${(err as { stdout?: string }).stdout?.split('\n').find((l) => /not ok|fail/i.test(l)) ?? (err as Error).message}`);
    } finally {
      await exec('git', ['worktree', 'remove', '--force', probe], { cwd: root }).catch(() => undefined);
    }
  });

  // 5. Delivery: apply to main, then undo.
  const delivery = summary
    ? new DeliveryService(summary.root, summary.git, new RunRepository(db!), new EventRepository(db!))
    : undefined;
  await stage('apply to the target branch', async () => {
    const status = delivery!.getDelivery(summary!.runId)?.status;
    if (status !== 'ready_to_apply') throw new Error(`delivery is "${status ?? 'missing'}", expected ready_to_apply`);
    await delivery!.apply(summary!.runId);
    if (!fs.existsSync(path.join(summary!.root, 'greet.js'))) throw new Error('applied, but greet.js is not in the working tree');
  });
  await stage('undo the applied run', async () => {
    await delivery!.undo(summary!.runId);
    if (fs.existsSync(path.join(summary!.root, 'greet.js'))) throw new Error('undone, but greet.js is still in the working tree');
  });

  const passed = stages.every((s) => s.state === 'passed');
  if (summary && db) {
    try {
      log(`\n  ${new TelemetryCollector(db).formatSpendLine(summary.runId, deps.budget)}`);
    } catch {
      // informational only
    }
  }
  log(
    passed
      ? '\n✔ The whole pipeline works on this machine: isolated worktree, agent edit, verification, integration, apply and undo.'
      : '\n✖ The self-test did not pass. Fix the stage marked ✖ above, then run `tf selftest` again.',
  );

  await worktrees?.prune().catch(() => undefined);
  try {
    db?.close();
  } catch {
    // already closed
  }
  if (sandbox && !deps.keep) fs.rmSync(sandbox, { recursive: true, force: true });
  else if (sandbox) log(`  Sandbox kept at ${sandbox}`);

  return { passed, stages, sandbox: deps.keep ? sandbox : undefined, agent: (agent as AgentAdapter | undefined)?.id };
}
