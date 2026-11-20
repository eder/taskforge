import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  TaskForgeDatabase,
  GoalRepository,
  RunRepository,
  TaskRepository,
  EventRepository,
} from '@taskforge/persistence';
import { classifyFocusedInstruction } from '../src/focused-run-resolver.js';
import { InteractiveShell } from '../src/interactive-shell.js';
import type { RunFocus } from '../src/run-focus.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (s: string) => s.replace(ANSI, '');

describe('classifyFocusedInstruction (open-text resolution in stopped runs)', () => {
  const fixFocus: RunFocus = { runId: 'run-1', action: { kind: 'fix' } };
  const continueFocus: RunFocus = { runId: 'run-1', action: { kind: 'continue' } };

  it('recognizes natural-language PT and EN acceptance of proposed environment fixes', () => {
    for (const msg of [
      'sim',
      'ok',
      'bora',
      'pode fazer isso',
      'pode subir o zaira e continuar',
      'sobe o serviço',
      'resolve isso pra mim',
      'conserta o ambiente',
      'go ahead',
      'fix it',
    ]) {
      expect(classifyFocusedInstruction(msg, fixFocus), msg).toEqual({ kind: 'accept_proposal' });
    }
  });

  it('recognizes open-text requests for the coding agent to fix code/test inconsistencies', () => {
    for (const msg of [
      'corrige o test_multiturn.py para não depender da porta 8765',
      'resolve essa inconsistência no teste e continua',
      'mocka a porta 8765 nos testes para passar',
      'fix the test inconsistency in test_multiturn.py',
    ]) {
      expect(classifyFocusedInstruction(msg, fixFocus), msg).toEqual({
        kind: 'fix_with_agent',
        guidance: msg,
      });
    }
  });

  it('recognizes explicit skip-preflight, check-command, shell-command, and leave directives', () => {
    expect(classifyFocusedInstruction('pula o preflight e continua', fixFocus)).toEqual({
      kind: 'skip_preflight',
      guidance: undefined,
    });
    expect(classifyFocusedInstruction('skip preflight', continueFocus)).toEqual({
      kind: 'skip_preflight',
      guidance: undefined,
    });
    expect(
      classifyFocusedInstruction(
        'usa o comando `cd server && .venv/bin/python -m pytest -q --ignore=tests/test_multiturn.py`',
        fixFocus,
      ),
    ).toEqual({
      kind: 'set_check_command',
      command: 'cd server && .venv/bin/python -m pytest -q --ignore=tests/test_multiturn.py',
    });
    expect(
      classifyFocusedInstruction('roda `docker compose -f docker-compose.yml up -d zaira`', fixFocus),
    ).toEqual({
      kind: 'run_shell_command',
      command: 'docker compose -f docker-compose.yml up -d zaira',
    });
    expect(classifyFocusedInstruction('cancela', fixFocus)).toEqual({ kind: 'leave' });
    expect(classifyFocusedInstruction('deixa pra lá', continueFocus)).toEqual({ kind: 'leave' });
  });

  it('keeps ordinary follow-up guidance as continue_with_guidance', () => {
    expect(classifyFocusedInstruction('use the smaller fixture set', continueFocus)).toEqual({
      kind: 'continue_with_guidance',
      guidance: 'use the smaller fixture set',
    });
  });
});

describe('InteractiveShell open-text resolution of stopped runs', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;
  const resumes: Array<{ runId: string; guidance?: string; skipPreflight?: boolean }> = [];

  beforeEach(() => {
    resumes.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-open-text-focus-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.taskforge/\ntest.db*\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
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

  function seedPreflightPortFailure(runId: string) {
    new GoalRepository(db).create({ id: `g-${runId}`, description: 'Memory v1', repository: dir });
    new RunRepository(db).create(runId, `g-${runId}`, {});
    new RunRepository(db).updateStatus(runId, 'failed');
    new TaskRepository(db).create({
      id: `T-${runId}`,
      runId,
      goalId: `g-${runId}`,
      title: 'Core Implementation',
      description: 'Implement phase 1',
      type: 'implementation',
      status: 'blocked',
      dependencies: [],
      contract: {
        objective: 'Implement phase 1',
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
        evidence:
          "Check 'explicit-1' failed with exit code 2 — ERROR test_multiturn.py - OSError: Connect call failed ('127.0.0.1', 8765)",
        action: 'block',
      },
      timestamp: new Date(),
    });
  }

  function openShell(): InteractiveShell {
    const s = new InteractiveShell({ repoRoot: dir, database: db });
    (
      s as unknown as {
        buildOrchestrator: () => {
          checkResumable: () => Promise<undefined>;
          resume: (
            runId: string,
            opts: { guidance?: string; skipPreflight?: boolean },
          ) => Promise<unknown>;
        };
      }
    ).buildOrchestrator = () => ({
      checkResumable: async () => undefined,
      resume: async (runId, opts) => {
        resumes.push({ runId, guidance: opts.guidance, skipPreflight: opts.skipPreflight });
        return {
          runId,
          goalId: 'g',
          status: 'completed',
          tasksCompleted: 1,
          tasksFailed: 0,
          durationMs: 1,
          graph: { getAllTasks: () => [] },
        };
      },
    });
    return s;
  }

  const enterStopped = (s: InteractiveShell, runId: string) =>
    (
      s as unknown as {
        formatRunSummary: (r: Record<string, unknown>) => Promise<string>;
      }
    ).formatRunSummary({
      runId,
      goalId: `g-${runId}`,
      status: 'failed',
      tasksCompleted: 0,
      tasksFailed: 1,
      durationMs: 10,
      graph: { getAllTasks: () => [] },
      error: 'preflight blocked',
    });

  it('hands an open-text inconsistency fix to the agent with skipPreflight and recorded evidence', async () => {
    seedPreflightPortFailure('run-1790000000000101');
    shell = openShell();
    await enterStopped(shell, 'run-1790000000000101');

    await shell.handleInput('corrige o test_multiturn.py para não depender da porta 8765');

    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe('run-1790000000000101');
    expect(resumes[0].skipPreflight).toBe(true);
    expect(resumes[0].guidance).toContain('corrige o test_multiturn.py');
    expect(resumes[0].guidance).toContain('8765');
  });

  it('accepts proposed environment fix via Portuguese open text without looping', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'LLM_API_KEY=secret\n');
    const runId = 'run-1790000000000102';
    new GoalRepository(db).create({ id: `g-${runId}`, description: 'Goal', repository: dir });
    new RunRepository(db).create(runId, `g-${runId}`, {});
    new RunRepository(db).updateStatus(runId, 'failed');
    new TaskRepository(db).create({
      id: `T-${runId}`,
      runId,
      goalId: `g-${runId}`,
      title: 'Core',
      description: 'Core',
      type: 'implementation',
      status: 'blocked',
      dependencies: [],
      contract: { objective: 'Core', allowedScope: ['**'], forbiddenChanges: [], acceptanceCriteria: [], dependencies: [] },
      acceptanceCriteria: [],
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
        reason: 'missing env',
        evidence: 'RuntimeError: no LLM api_key configured',
        action: 'block',
      },
      timestamp: new Date(),
    });

    shell = openShell();
    await enterStopped(shell, runId);

    await shell.handleInput('pode fazer isso e continuar');

    expect(fs.readFileSync(path.join(dir, '.taskforge/config.yaml'), 'utf8')).toContain('.env');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe(runId);
  });

  it('supports explicit skip-preflight and replacement check commands in open text', async () => {
    seedPreflightPortFailure('run-1790000000000103');
    shell = openShell();
    await enterStopped(shell, 'run-1790000000000103');

    await shell.handleInput('pula o preflight');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].skipPreflight).toBe(true);

    resumes.length = 0;
    await enterStopped(shell, 'run-1790000000000103');
    const reply = plain(
      await shell.handleInput('usa o comando `pytest -q --ignore=tests/test_multiturn.py`'),
    );
    expect(reply).not.toContain('Command failed');
    expect(fs.readFileSync(path.join(dir, '.taskforge/config.yaml'), 'utf8')).toContain(
      'pytest -q --ignore=tests/test_multiturn.py',
    );
    expect(resumes).toHaveLength(1);
  });

  it('answers "Por que falhou ?" without polluting guidance, and retries immediately on "Tente de novo"', async () => {
    seedPreflightPortFailure('run-1790000000000104');
    shell = openShell();
    await enterStopped(shell, 'run-1790000000000104');

    const explanation = plain(await shell.handleInput('Por que falhou ?'));
    expect(explanation).toContain('Por que run-1790000000000104 parou');
    expect(explanation).toContain('8765');
    expect(resumes).toHaveLength(0);

    await shell.handleInput('Tente de novo');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe('run-1790000000000104');
    expect(resumes[0].guidance).toBeUndefined();
  });
});
