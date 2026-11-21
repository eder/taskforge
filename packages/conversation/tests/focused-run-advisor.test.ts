import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TaskForgeDatabase,
  RunRepository,
  GoalRepository,
  TaskRepository,
  EventRepository,
} from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';
import {
  FocusedRunAdvisor,
  validateWorktreeLinkPaths,
  type FocusedAdvisorDecision,
} from '../src/focused-run-advisor.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string) => text.replace(ANSI, '');

describe('validateWorktreeLinkPaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-advisor-paths-'));
    fs.mkdirSync(path.join(dir, 'testdata'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.env'), 'A=1\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps existing repo-relative paths and rejects traversal, .git, and missing paths', () => {
    expect(
      validateWorktreeLinkPaths(dir, [
        'testdata',
        './server.env',
        '../outside',
        '.git/config',
        'does-not-exist',
      ]),
    ).toEqual(['testdata', 'server.env']);
  });
});

describe('InteractiveShell conversational failure advisor & agent investigation', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;
  const resumes: Array<{
    runId: string;
    guidance?: string;
    skipPreflight?: boolean;
    repairTask?: { title: string; description: string; preferredAgent?: string };
  }> = [];
  const runs: Array<{ goal: string; intent?: string }> = [];

  beforeEach(() => {
    resumes.length = 0;
    runs.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-advisor-shell-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'testdata/\n.taskforge/\ntest.db*\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# zaira\n');
    fs.mkdirSync(path.join(dir, 'testdata'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'testdata/sample.pcm'), 'audio');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedBlockedRun(runId: string) {
    new GoalRepository(db).create({ id: `g-${runId}`, description: 'Fix memory bugs', repository: dir });
    new RunRepository(db).create(runId, `g-${runId}`, {});
    new RunRepository(db).updateStatus(runId, 'failed');
    new TaskRepository(db).create({
      id: `T-${runId}`,
      runId,
      goalId: `g-${runId}`,
      title: 'Fix memory bugs',
      description: 'Fix memory bugs',
      type: 'implementation',
      status: 'blocked',
      dependencies: [],
      contract: {
        objective: 'Fix memory bugs',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Tests pass'],
        dependencies: [],
      },
      acceptanceCriteria: ['Tests pass'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    new EventRepository(db).append({
      id: `evt-${runId}`,
      runId,
      taskId: `T-${runId}`,
      type: 'TASK_RECOVERY_BLOCKED',
      payload: {
        failureClass: 'environment',
        reason: "Check 'explicit-1' failed with exit code 2",
        evidence: "ERROR test_memory.py - FileNotFoundError: '../testdata/sample.pcm'",
        action: 'block',
      },
      timestamp: new Date(),
    });
  }

  type ShellInternals = {
    focusedAdvisor: FocusedRunAdvisor;
    focusedRun?: { runId: string; history?: Array<{ role: string; content: string }> };
    formatRunSummary: (r: Record<string, unknown>) => Promise<string>;
    buildOrchestrator: () => {
      checkResumable: () => Promise<undefined>;
      resume: (
        runId: string,
        opts: {
          guidance?: string;
          skipPreflight?: boolean;
          repairTask?: { title: string; description: string; preferredAgent?: string };
        },
      ) => Promise<unknown>;
      run: (
        goal: string,
        opts: { runId?: string; executionIntent?: { intent: string } },
      ) => Promise<unknown>;
    };
  };

  function openShell(): InteractiveShell {
    const s = new InteractiveShell({ repoRoot: dir, database: db });
    const internals = s as unknown as ShellInternals;
    internals.buildOrchestrator = () => ({
      checkResumable: async () => undefined,
      resume: async (runId, opts) => {
        resumes.push({
          runId,
          guidance: opts.guidance,
          skipPreflight: opts.skipPreflight,
          repairTask: opts.repairTask,
        });
        return {
          runId,
          goalId: `g-${runId}`,
          status: 'completed',
          tasksCompleted: 1,
          tasksFailed: 0,
          durationMs: 1,
          graph: { getAllTasks: () => [] },
        };
      },
      run: async (goal, opts) => {
        runs.push({ goal, intent: opts.executionIntent?.intent });
        return {
          runId: opts.runId ?? 'run-diag-1',
          goalId: 'g-diag',
          status: 'completed',
          tasksCompleted: 1,
          tasksFailed: 0,
          durationMs: 5,
          graph: { getAllTasks: () => [] },
        };
      },
    });
    return s;
  }

  const enterStopped = (s: InteractiveShell, runId: string) =>
    (s as unknown as ShellInternals).formatRunSummary({
      runId,
      goalId: `g-${runId}`,
      status: 'failed',
      tasksCompleted: 0,
      tasksFailed: 1,
      durationMs: 10,
      graph: { getAllTasks: () => [] },
      error: 'preflight blocked',
    });

  it('answers open-text questions via the advisor, remembers proposed action, and executes it on confirmation', async () => {
    const runId = 'run-1790000000000201';
    seedBlockedRun(runId);
    shell = openShell();
    const internals = shell as unknown as ShellInternals;

    internals.focusedAdvisor.setHandler(async (): Promise<FocusedAdvisorDecision> => ({
      action: 'answer',
      reply:
        'A pasta testdata/ está no .gitignore e não existe na worktree isolada.\n1. Linkar testdata em .taskforge/config.yaml\n2. Pedir para um agente isolar o teste',
      command: null,
      paths: ['testdata'],
      guidance: null,
      proposedAction: 'add_worktree_links',
    }));

    await enterStopped(shell, runId);
    const reply = plain(
      await shell.handleInput('não entendi esse erro de testdata, qual a melhor saída?'),
    );
    expect(reply).toContain('TaskForge Advisor');
    expect(reply).toContain('testdata/');
    expect(reply).toContain('link testdata into worktrees and continue');
    expect(resumes).toHaveLength(0);

    // Confirming with "pode fazer" executes the advisor's proposed worktree link action.
    await shell.handleInput('pode fazer');
    expect(fs.readFileSync(path.join(dir, '.taskforge/config.yaml'), 'utf8')).toContain('testdata');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe(runId);
  });

  it('stages LLM-suggested shell commands for explicit confirmation before executing', async () => {
    const runId = 'run-1790000000000202';
    seedBlockedRun(runId);
    shell = openShell();
    const internals = shell as unknown as ShellInternals;

    internals.focusedAdvisor.setHandler(async (): Promise<FocusedAdvisorDecision> => ({
      action: 'run_shell_command',
      reply: 'Posso gerar os fixtures antes de retomar:',
      command: 'echo ready',
      paths: null,
      guidance: null,
      proposedAction: 'none',
    }));

    await enterStopped(shell, runId);
    const first = plain(await shell.handleInput('como destravo isso com script?'));
    expect(first).toContain('$ echo ready');
    expect(resumes).toHaveLength(0);

    await shell.handleInput('pode rodar');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe(runId);
  });

  it('launches a read-only coding agent investigation and keeps the stopped run focused for follow-up', async () => {
    const runId = 'run-1790000000000203';
    seedBlockedRun(runId);
    shell = openShell();
    const internals = shell as unknown as ShellInternals;

    await enterStopped(shell, runId);
    const reply = plain(
      await shell.handleInput('pede pro codex investigar esse erro no código antes de alterar'),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].intent).toBe('READ_ONLY_ANALYSIS');
    expect(runs[0].goal).toContain(runId);
    expect(runs[0].goal).toContain('testdata/sample.pcm');
    expect(reply).toContain(`Still focused on ${runId}`);
    expect(internals.focusedRun?.runId).toBe(runId);
    expect(internals.focusedRun?.history?.length).toBeGreaterThanOrEqual(2);
  });

  it('dispatches fix_with_agent with skipPreflight and recorded evidence when user asks advisor to solve via agent', async () => {
    const runId = 'run-1790000000000204';
    seedBlockedRun(runId);
    shell = openShell();
    const internals = shell as unknown as ShellInternals;

    internals.focusedAdvisor.setHandler(async (): Promise<FocusedAdvisorDecision> => ({
      action: 'fix_with_agent',
      reply: 'Vou passar para o agente ajustar o teste para não depender do arquivo externo.',
      command: null,
      paths: null,
      guidance: 'Refactor test_memory.py to generate a synthetic PCM buffer instead of reading ../testdata/sample.pcm',
      proposedAction: 'none',
    }));

    await enterStopped(shell, runId);
    await shell.handleInput('não quero depender de arquivos externos, pede pro codex resolver isso');

    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe(runId);
    expect(resumes[0].skipPreflight).toBe(true);
    expect(resumes[0].repairTask?.preferredAgent).toBe('codex');
    expect(resumes[0].repairTask?.description).toContain('synthetic PCM buffer');
    expect(resumes[0].repairTask?.description).toContain('Check');
  });

  it('leaves the stopped run and plans a new goal when the advisor classifies the message as new_task', async () => {
    const runId = 'run-1790000000000205';
    seedBlockedRun(runId);
    shell = openShell();
    const internals = shell as unknown as ShellInternals;

    internals.focusedAdvisor.setHandler(async (): Promise<FocusedAdvisorDecision> => ({
      action: 'new_task',
      reply: '',
      command: null,
      paths: null,
      guidance: null,
      proposedAction: 'none',
    }));

    await enterStopped(shell, runId);
    const reply = plain(
      await shell.handleInput('implement a new webhook health endpoint with tests'),
    );

    expect(resumes).toHaveLength(0);
    expect(internals.focusedRun).toBeUndefined();
    expect(reply).toContain('Plan Proposal');
  });
});
