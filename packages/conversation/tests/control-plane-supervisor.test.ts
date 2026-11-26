import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryService } from '@taskforge/integration';
import { EventRepository, RunRepository, TaskForgeDatabase, TaskRepository } from '@taskforge/persistence';
import { getDefaultConfig, type RepositoryProfile } from '@taskforge/shared';
import { AgentRegistry } from '@taskforge/agents';
import { GitService } from '@taskforge/workspace';
import {
  bootstrapWorkspaceAfterApply,
  buildDeterministicLivingPlan,
  collectControlPlaneSnapshot,
  compileWaveToTaskGraph,
  formatControlPlaneContextForPrompt,
  InteractiveShell,
  markWaveStatus,
  reconcileModuleScopeWithRepo,
  saveLivingPlan,
} from '../src/index.js';

function createGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-supervisor-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.taskforge/\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Control-Plane Supervisor, Scope Reconciliation, Auto-Bootstrap & Smart Guards', () => {
  it('reconciles greenfield placeholder module scopes against real Wave 1 directories without overlapping siblings', () => {
    const plan = buildDeterministicLivingPlan('Barbearia PWA');
    plan.modules = [
      { id: 'm1', name: 'User Authentication', responsibility: 'Auth', scope: ['auth', 'user'], dependsOn: [] },
      { id: 'm2', name: 'Notification System', responsibility: 'Notifications', scope: ['notifications'], dependsOn: [] },
      { id: 'm3', name: 'User Interface', responsibility: 'UI', scope: ['ui'], dependsOn: ['m1'] },
    ];
    plan.waves[1].modules = ['m1', 'm2', 'm3'];

    const liveProfile: RepositoryProfile = {
      languages: ['TypeScript'],
      frameworks: ['React'],
      testCommands: [],
      lintCommands: [],
      typecheckCommands: [],
      buildCommands: [],
      hasECC: false,
      summary: 'repo',
      repositoryMap: [
        'src/worker/auth/ — 1 files (gitkeep 1)',
        'src/worker/notifications/ — 1 files (gitkeep 1)',
        'src/web/app/ — 1 files (gitkeep 1)',
        'src/web/pages/ — 1 files (gitkeep 1)',
        'tests/unit/ — 1 files (gitkeep 1)',
      ],
    };

    const authScope = reconcileModuleScopeWithRepo(plan.modules[0], plan.modules, liveProfile);
    expect(authScope).toContain('src/worker/auth/**');
    expect(authScope).toContain('tests/unit/auth/**');
    expect(authScope).not.toContain('src/worker/notifications/**');

    const notifScope = reconcileModuleScopeWithRepo(plan.modules[1], plan.modules, liveProfile);
    expect(notifScope).toContain('src/worker/notifications/**');
    expect(notifScope).toContain('tests/unit/notifications/**');

    const uiScope = reconcileModuleScopeWithRepo(plan.modules[2], plan.modules, liveProfile);
    expect(uiScope).toContain('src/web/**');
    expect(uiScope).not.toContain('src/web/pages/**'); // collapsed under ancestor src/web/**

    const graph = compileWaveToTaskGraph(plan, plan.waves[1], 'goal-1', liveProfile);
    expect(graph).toBeDefined();
    expect(graph?.getTask('TASK-01')?.contract.allowedScope).toContain('src/worker/auth/**');
    expect(graph?.getTask('TASK-02')?.contract.allowedScope).toContain('src/worker/notifications/**');
    expect(graph?.getTask('TASK-03')?.contract.allowedScope).toContain('src/web/**');
  });

  it('auto-installs missing node_modules on host and upgrades placeholder git diff --check to package.json scripts', async () => {
    const repoRoot = createGitRepo();
    tempDirs.push(repoRoot);

    fs.mkdirSync(path.join(repoRoot, '.taskforge'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.taskforge', 'config.yaml'),
      'verification:\n  commands:\n    - git diff --check\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
        dependencies: { hono: '^4.0.0' },
      }),
      'utf8',
    );

    const config = getDefaultConfig();
    config.verification.commands = ['git diff --check'];

    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const res = await bootstrapWorkspaceAfterApply(repoRoot, config, {
      runInstall: async (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
        return { exitCode: 0 };
      },
    });

    expect(calls).toEqual([{ cmd: 'npm', args: ['install'], cwd: repoRoot }]);
    expect(res.installed).toBe(true);
    expect(res.upgradedVerification).toBe(true);
    expect(config.verification.commands).toEqual([]);
    const updatedYaml = fs.readFileSync(path.join(repoRoot, '.taskforge', 'config.yaml'), 'utf8');
    expect(updatedYaml).not.toContain('git diff --check');

    // Respects permissions.commands.package_install: 'deny'
    fs.rmSync(path.join(repoRoot, 'node_modules'), { recursive: true, force: true });
    config.permissions.commands.package_install = 'deny';
    const denied = await bootstrapWorkspaceAfterApply(repoRoot, config, {
      runInstall: async () => {
        throw new Error('should not run');
      },
    });
    expect(denied.installed).toBe(false);
    expect(denied.notes[0]).toContain('auto-install disabled');
  });

  it('auto-applies an unmerged READY TO APPLY run before /blueprint next launches Wave 2', async () => {
    const repoRoot = createGitRepo();
    tempDirs.push(repoRoot);

    // Prepare a Living Plan with Wave 1 already completed and Wave 2 pending
    let plan = buildDeterministicLivingPlan('Build demo app with auth and billing');
    plan = markWaveStatus(plan, 1, 'completed', { runId: 'run-wave-1', summary: 'done' });
    saveLivingPlan(repoRoot, plan);

    // Create a separate unmerged `ready_to_apply` scaffolding run branch (like package.json added before Wave 2)
    execFileSync('git', ['checkout', '-b', 'taskforge/run-scaffold'], { cwd: repoRoot, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoRoot, 'scaffold.txt'), 'ready\n', 'utf8');
    execFileSync('git', ['add', 'scaffold.txt'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'chore: scaffold'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['checkout', 'main'], { cwd: repoRoot, stdio: 'ignore' });
    expect(fs.existsSync(path.join(repoRoot, 'scaffold.txt'))).toBe(false);

    const db = new TaskForgeDatabase(':memory:');
    const runRepo = new RunRepository(db);
    runRepo.create('run-scaffold', 'goal-scaffold', {
      delivery: {
        branch: 'taskforge/run-scaffold',
        targetBranch: 'main',
        status: 'ready_to_apply',
        baseCommit: execFileSync('git', ['rev-parse', 'main'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
        createdAt: new Date().toISOString(),
      },
    });
    runRepo.updateStatus('run-scaffold', 'completed');

    const config = getDefaultConfig();
    config.verification.preflight = false;
    config.verification.commands = [];
    config.planner.agentPlanning = 'never';

    const shell = new InteractiveShell({
      repoRoot,
      config,
      database: db,
      output: new PassThrough(),
      interactive: false,
      smartDirectDispatch: false,
    });

    const out = await shell.handleInput('/blueprint next');
    expect(out).toContain('Auto-applied pending run run-scaffold');
    expect(fs.existsSync(path.join(repoRoot, 'scaffold.txt'))).toBe(true);
    db.close();
  });

  it('makes /retry apply a 0-token scope expansion fix directly instead of blindly re-running into the same scope error', async () => {
    const repoRoot = createGitRepo();
    tempDirs.push(repoRoot);

    const db = new TaskForgeDatabase(':memory:');
    const runRepo = new RunRepository(db);
    const taskRepo = new TaskRepository(db);
    const eventRepo = new EventRepository(db);

    runRepo.create('run-scope-blocked', 'goal-scope');
    runRepo.updateStatus('run-scope-blocked', 'failed');
    taskRepo.create({
      id: 'TASK-01',
      runId: 'run-scope-blocked',
      goalId: 'goal-scope',
      title: 'Implement User Authentication',
      description: 'Auth',
      type: 'implementation',
      status: 'blocked',
      dependencies: [],
      acceptanceCriteria: ['works'],
      contract: {
        objective: 'Auth',
        allowedScope: ['auth'],
        forbiddenChanges: [],
        acceptanceCriteria: ['works'],
        dependencies: [],
      },
    });
    eventRepo.append({
      id: 'evt-scope-1',
      runId: 'run-scope-blocked',
      taskId: 'TASK-01',
      type: 'SCOPE_VIOLATION',
      payload: {
        violations: ['src/worker/auth/service.ts', 'tests/unit/auth/auth.test.ts'],
        allowedScope: ['auth'],
      },
      timestamp: new Date(),
    });
    eventRepo.append({
      id: 'evt-cand-1',
      runId: 'run-scope-blocked',
      taskId: 'TASK-01',
      type: 'TASK_CANDIDATE_PRESERVED',
      payload: {
        commitHash: 'abc1234',
        branch: 'taskforge/candidate/run-scope-blocked/TASK-01',
      },
      timestamp: new Date(),
    });

    const shell = new InteractiveShell({
      repoRoot,
      config: getDefaultConfig(),
      database: db,
      output: new PassThrough(),
      interactive: false,
      smartDirectDispatch: false,
    });

    const expandSpy = vi
      .spyOn(
        shell as unknown as { expandTaskScopeAndContinue: (...args: unknown[]) => Promise<string> },
        'expandTaskScopeAndContinue',
      )
      .mockResolvedValue('EXPANDED_AND_RESUMED');

    const reply = await shell.handleInput('/retry run-scope-blocked');
    expect(reply).toBe('EXPANDED_AND_RESUMED');
    expect(expandSpy).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('builds a real-time Control-Plane Supervisor snapshot surfacing unapplied runs, failed waves, missing node_modules, and placeholder checks', () => {
    const repoRoot = createGitRepo();
    tempDirs.push(repoRoot);

    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'barbershop',
        scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
        dependencies: { hono: '^4.0.0' },
      }),
      'utf8',
    );
    const plan = buildDeterministicLivingPlan('Barbearia PWA');
    saveLivingPlan(repoRoot, plan);

    const db = new TaskForgeDatabase(':memory:');
    const runRepo = new RunRepository(db);
    runRepo.create('run-ready-99', 'g-1', {
      delivery: {
        branch: 'taskforge/run-ready-99',
        targetBranch: 'main',
        status: 'ready_to_apply',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      },
    });
    runRepo.updateStatus('run-ready-99', 'completed');

    const config = getDefaultConfig();
    config.verification.commands = ['git diff --check'];

    const snapshot = collectControlPlaneSnapshot({
      repoRoot,
      config,
      db,
      deliveryService: new DeliveryService(repoRoot, new GitService(repoRoot), runRepo),
      agentRegistry: new AgentRegistry(false),
    });

    expect(snapshot.readyRuns.map((r) => r.runId)).toContain('run-ready-99');
    expect(snapshot.environmentIssues.some((i) => i.includes('node_modules is missing'))).toBe(true);
    expect(snapshot.environmentIssues.some((i) => i.includes('git diff --check'))).toBe(true);

    const promptBlock = formatControlPlaneContextForPrompt(snapshot)!;
    expect(promptBlock).toContain('[TaskForge Control-Plane State');
    expect(promptBlock).toContain('/apply run-ready-99');
    expect(promptBlock).toContain('Living Plan (.taskforge/plan.md)');
    expect(promptBlock).toContain('node_modules is missing');
    db.close();
  });

  it('clears focusedRun on /blueprint next so FocusedRunAdvisor never hijacks the next wave, and blocks apply_repair when availableRepairs is empty', async () => {
    const repoRoot = createGitRepo();
    tempDirs.push(repoRoot);

    let plan = buildDeterministicLivingPlan('Build demo app with auth and billing');
    plan = markWaveStatus(plan, 1, 'completed', { runId: 'run-w1', summary: 'done' });
    saveLivingPlan(repoRoot, plan);

    const db = new TaskForgeDatabase(':memory:');
    const config = getDefaultConfig();
    config.verification.preflight = false;
    config.verification.commands = [];
    config.planner.agentPlanning = 'never';

    const shell = new InteractiveShell({
      repoRoot,
      config,
      database: db,
      output: new PassThrough(),
      interactive: false,
      smartDirectDispatch: false,
    });

    // Simulate a previously failed focused run still active in REPL
    (shell as unknown as { focusedRun?: unknown }).focusedRun = {
      runId: 'run-stale-failed',
      action: { kind: 'continue' },
    };

    const wave2Out = await shell.handleInput('/blueprint next');
    expect(wave2Out).toContain('Plan Proposal');
    expect(wave2Out).not.toContain('TaskForge Advisor');

    // Advisor must never emit `apply_repair` when availableRepairs is empty
    const advisor = (shell as unknown as {
      focusedAdvisor: {
        setHandler: (fn: () => Promise<unknown>) => void;
        advise: (input: Record<string, unknown>) => Promise<{ action: string; proposedAction: string } | undefined>;
      };
    }).focusedAdvisor;
    advisor.setHandler(async () => ({
      action: 'answer',
      reply: 'Run tf init',
      command: null,
      paths: null,
      guidance: null,
      proposedAction: 'apply_repair',
    }));

    const sanitized = await advisor.advise({
      userMessage: 'why did it fail?',
      runId: 'run-stale-failed',
      goal: 'test',
      failures: [],
      availableRepairs: [],
      verificationCommands: [],
      worktreeLinks: [],
      availableAgents: ['Codex CLI (codex)'],
    });
    expect(sanitized?.action).toBe('answer');
    expect(sanitized?.proposedAction).toBe('none');
    db.close();
  });
});
