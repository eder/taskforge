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
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { TaskGraph, type Task } from '@taskforge/core';
import type { RoutingProvider } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { filesOutsideScope, scopeAllowsPath } from '../src/task-policy.js';
import { type GitSandbox, withGitSandbox } from './helpers/git-sandbox.js';

describe('scope matching', () => {
  it('treats empty and repository-wide scopes as unconstrained', () => {
    expect(filesOutsideScope(undefined, ['a.ts'])).toEqual([]);
    expect(filesOutsideScope([], ['a.ts'])).toEqual([]);
    expect(filesOutsideScope(['*'], ['a.ts', 'src/b.ts'])).toEqual([]);
    expect(filesOutsideScope(['**'], ['src/b.ts'])).toEqual([]);
  });

  it('matches directory, glob and exact scopes', () => {
    expect(scopeAllowsPath(['src/auth/**'], 'src/auth/login.ts')).toBe(true);
    expect(scopeAllowsPath(['src/auth/**'], 'src/authz/login.ts')).toBe(false);
    expect(scopeAllowsPath(['src/auth'], 'src/auth/deep/x.ts')).toBe(true);
    expect(scopeAllowsPath(['src/*.ts'], 'src/a.ts')).toBe(true);
    expect(scopeAllowsPath(['src/*.ts'], 'src/nested/a.ts')).toBe(false);
    expect(scopeAllowsPath(['**/*.test.ts'], 'src/a/b.test.ts')).toBe(true);
    expect(scopeAllowsPath(['package.json'], 'package.json')).toBe(true);
    expect(scopeAllowsPath(['./src/**'], 'src/x.ts')).toBe(true);
  });

  it('reports only the files outside every allowed scope', () => {
    expect(
      filesOutsideScope(['src/auth/**', 'docs/**'], [
        'src/auth/a.ts',
        'docs/x.md',
        'src/billing/b.ts',
        '.github/workflows/ci.yml',
      ]),
    ).toEqual(['src/billing/b.ts', '.github/workflows/ci.yml']);
  });
});

class WritingAgent implements AgentAdapter {
  readonly id = 'writer';
  readonly name = 'Writer';
  public calls = 0;
  constructor(
    private files: (call: number) => string[],
    private remove: (call: number) => string[] = () => [],
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return { canRead: true, canWrite: true, canExecute: true, languages: [], tools: ['git'] };
  }
  async execute(_a: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls++;
    const git = new GitService(context.worktreePath);
    for (const file of this.files(this.calls)) {
      const full = path.join(context.worktreePath, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, `change ${this.calls}\n`);
    }
    for (const file of this.remove(this.calls)) {
      fs.rmSync(path.join(context.worktreePath, file), { force: true });
    }
    const commitHash = await git.stageAndCommit(`feat: attempt ${this.calls}`, context.worktreePath);
    return { success: true, message: 'done', output: 'done', durationMs: 1, commitHash };
  }
}

function scopedTask(): Task {
  return {
    id: 'TASK-SCOPED',
    goalId: 'goal-scope',
    title: 'Change auth only',
    description: 'Change auth only',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Change files under src/auth only',
      allowedScope: ['src/auth/**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['auth changed'],
      dependencies: [],
    },
    acceptanceCriteria: ['auth changed'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe.concurrent('allowedScope enforcement', () => {
  function run(
    sandbox: GitSandbox,
    agent: AgentAdapter,
    patch: (c: ReturnType<typeof getDefaultConfig>) => void = () => {},
  ) {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(agent);
    const router: RoutingProvider = {
      id: 'scope-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canRead', 'canWrite'],
            objective: 'Implement',
            preferredAgent: agent.id,
          },
        ],
        communication: { required: false, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'deterministic',
      }),
    };
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    patch(config);
    const graph = new TaskGraph();
    graph.addTask(scopedTask());
    const orchestrator = new RunOrchestrator({
      repoRoot: sandbox.root,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService: sandbox.git,
      worktreeManager: sandbox.worktrees,
    });
    return { db, result: orchestrator.run('Change auth', { preplannedGraph: graph }) };
  }

  it('integrates a change that stays inside the scope', async () => {
    await withGitSandbox(async (sandbox) => {
      const { db, result } = run(sandbox, new WritingAgent(() => ['src/auth/login.ts']));
      const r = await result;
      expect(r.status).toBe('completed');
      db.close();
    });
  });

  it('rejects a change that touches files outside the scope and never integrates it', async () => {
    await withGitSandbox(async (sandbox) => {
      const agent = new WritingAgent(() => ['src/auth/login.ts', 'src/billing/charge.ts']);
      const { db, result } = run(sandbox, agent);
      const r = await result;

      expect(r.status).toBe('failed');
      expect(r.integrationBranch).toBeUndefined();
      const events = new EventRepository(db).listByRun(r.runId);
      const violation = events.find((e) => e.type === 'SCOPE_VIOLATION');
      expect(JSON.stringify(violation?.payload)).toContain('src/billing/charge.ts');
      expect(JSON.stringify(violation?.payload)).not.toContain('"src/auth/login.ts"');
      db.close();
    });
  });

  it('completes once a retry reverts the stray file, using the violation as evidence', async () => {
    await withGitSandbox(async (sandbox) => {
      const agent = new WritingAgent(
        (call) => ['src/auth/login.ts', ...(call === 1 ? ['package.json'] : [])],
        (call) => (call === 2 ? ['package.json'] : []),
      );
      const { db, result } = run(sandbox, agent);
      const r = await result;

      expect(r.status).toBe('completed');
      expect(agent.calls).toBe(2);
      db.close();
    });
  });

  it('blocks when retries keep the stray file in the candidate', async () => {
    await withGitSandbox(async (sandbox) => {
      const agent = new WritingAgent((call) =>
        call === 1 ? ['src/auth/login.ts', 'package.json'] : ['src/auth/login.ts'],
      );
      const { db, result } = run(sandbox, agent);
      const r = await result;

      expect(r.status).toBe('failed');
      expect(agent.calls).toBeGreaterThanOrEqual(2);
      db.close();
    });
  });

  it('can be disabled with verification.enforceScope: false', async () => {
    await withGitSandbox(async (sandbox) => {
      const agent = new WritingAgent(() => ['src/billing/charge.ts']);
      const { db, result } = run(sandbox, agent, (c) => {
        c.verification.enforceScope = false;
      });
      const r = await result;
      expect(r.status).toBe('completed');
      db.close();
    });
  });
});
