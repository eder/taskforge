import { describe, it, expect } from 'vitest';
import { classifyVerificationFailure } from '../src/task-recovery.js';
import { recommendNextStep, environmentHint, formatRunFailureLines, type RunFailureLine } from '../src/run-failure-report.js';

// The output of a real run: 35 test files could not even be collected because
// the isolated copy had no LLM key and no database.
const REAL_OUTPUT = `Check 'explicit-1' failed with exit code 2
Command: cd server && .venv/bin/python -m pytest -q
Last output:
ERROR test_uploads.py - RuntimeError: no LLM api_key configured
ERROR test_wake_button.py - OSError: Multiple exceptions: [Errno 61] Connect call failed ('127.0.0.1', 5432)
ERROR test_weekly_report.py - RuntimeError: no LLM api_key configured
!!!!!!!!!!!!!!!!!!! Interrupted: 35 errors during collection !!!!!!!!!!!!!!!!!!!`;

describe('environment failures are not the agent’s fault', () => {
  it('classifies the real zaira output as environment, so the agent is not retried', () => {
    expect(classifyVerificationFailure(REAL_OUTPUT)).toBe('environment');
  });

  it.each([
    'psycopg2.OperationalError: could not connect to server: Connection refused',
    'ECONNREFUSED 127.0.0.1:6379',
    'ModuleNotFoundError: No module named boto3',
    'Error: Cannot find module \'dotenv\'',
    'KeyError: missing environment variable STRIPE_API_KEY',
    'RuntimeError: no OpenAI api key configured',
  ])('recognises "%s"', (output) => {
    expect(classifyVerificationFailure(output)).toBe('environment');
  });

  it.each([
    'AssertionError: expected 3 to equal 4',
    'TypeError: cannot read properties of undefined',
    'FAILED test_math.py::test_add - assert 1 == 2',
    'ImportError: cannot import name make_thing from app',
  ])('leaves real code failures alone: "%s"', (output) => {
    expect(classifyVerificationFailure(output)).toBe('code_or_test');
  });
});

describe('environmentHint', () => {
  it('names the concrete fix for each cause found in the output', () => {
    const hint = environmentHint([REAL_OUTPUT]);
    expect(hint).toContain('verification.passEnv');
    expect(hint).toContain('a database');
    expect(environmentHint(['ModuleNotFoundError: boto3'])).toContain('dependency is not installed');
    expect(environmentHint(['no .env found'])).toContain('execution.worktreeLinks');
    expect(environmentHint(['weird'])).toContain('cannot run in this environment');
  });

  it('is what the recommended next step says, and a retry is not offered as one key', () => {
    const line: RunFailureLine = {
      taskId: 'T1',
      title: 'x',
      kind: 'blocked',
      reason: REAL_OUTPUT,
      failureClass: 'environment',
      keptBranch: 'taskforge/candidate/1/T1',
    };
    const step = recommendNextStep([line], 'run-1')!;
    expect(step.runnable).toBe(false);
    expect(step.why).toContain('verification.passEnv');
    const text = formatRunFailureLines([line], 'run-1').join('\n');
    expect(text).toContain('git show --stat taskforge/candidate/1/T1');
  });
});

describe('a retry that costs a lot is not a one-key action', () => {
  const failed: RunFailureLine = { taskId: 'T1', title: 'x', kind: 'failed', reason: 'boom' };

  it('is one-key while the run is cheap, and a deliberate choice once it used most of its budget', () => {
    expect(recommendNextStep([failed], 'run-1', { spent: 100_000, budget: 2_000_000 })!.runnable).toBe(true);
    const costly = recommendNextStep([failed], 'run-1', { spent: 1_750_000, budget: 2_000_000 })!;
    expect(costly.runnable).toBe(false);
    expect(costly.why).toContain('already used 88% of its token budget');
  });

  it('ignores the budget when there is no cap', () => {
    expect(recommendNextStep([failed], 'run-1', { spent: 9_000_000, budget: 0 })!.runnable).toBe(true);
  });
});

describe('diagnosis does not depend on the order events were written in', () => {
  it('keeps the full check output even when a shorter event for the same task sorts newer', async () => {
    const { TaskForgeDatabase, TaskRepository, EventRepository } = await import('@taskforge/persistence');
    const { describeRunFailures } = await import('../src/run-failure-report.js');
    const db = new TaskForgeDatabase(':memory:');
    db.prepare("INSERT INTO runs (id, status, created_at) VALUES ('run-1', 'failed', ?)").run(new Date().toISOString());
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run('T1', 'run-1', 'Task', 'x', 'implementation', 'blocked', new Date().toISOString(), new Date().toISOString());
    const events = new EventRepository(db);
    const same = new Date(); // identical timestamps, as when two events are written back to back
    events.append({ id: 'e1', runId: 'run-1', taskId: 'T1', type: 'TASK_RECOVERY_BLOCKED', payload: { failureClass: 'environment', reason: 'Check failed', evidence: REAL_OUTPUT }, timestamp: same });
    events.append({ id: 'e2', runId: 'run-1', taskId: 'T1', type: 'TASK_FAILED', payload: { reason: 'Preflight: Check failed' }, timestamp: same });
    const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: events }, 'run-1');
    expect(lines[0].evidence).toContain('no LLM api_key configured');
    expect(lines[0].evidence).toContain('5432');
    // The headline is the detailed one too, whichever event was written last.
    expect(lines[0].reason).toContain('Check failed');
    expect(lines[0].reason).not.toMatch(/^Preflight:/);
    db.close();
  });

  it('describes two tasks blocked by the same cause the same way, whatever order their events were written in', async () => {
    const { TaskForgeDatabase, TaskRepository, EventRepository } = await import('@taskforge/persistence');
    const { describeRunFailures } = await import('../src/run-failure-report.js');
    const db = new TaskForgeDatabase(':memory:');
    db.prepare("INSERT INTO runs (id, status, created_at) VALUES ('run-2', 'failed', ?)").run(new Date().toISOString());
    for (const id of ['A', 'B']) {
      db.prepare(
        'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      ).run(id, 'run-2', `Task ${id}`, 'x', 'implementation', 'blocked', new Date().toISOString(), new Date().toISOString());
    }
    const events = new EventRepository(db);
    const same = new Date();
    const blocked = (taskId: string, id: string) =>
      events.append({ id, runId: 'run-2', taskId, type: 'TASK_RECOVERY_BLOCKED', payload: { failureClass: 'environment', reason: 'Check failed', evidence: REAL_OUTPUT }, timestamp: same });
    const note = (taskId: string, id: string) =>
      events.append({ id, runId: 'run-2', taskId, type: 'TASK_FAILED', payload: { reason: 'Preflight: Check failed' }, timestamp: same });
    blocked('A', 'a1');
    note('A', 'a2'); // the short note is written last for A ...
    note('B', 'b1');
    blocked('B', 'b2'); // ... and first for B
    const lines = describeRunFailures({ taskRepo: new TaskRepository(db), eventRepo: events }, 'run-2');
    expect(lines[0].reason).toBe(lines[1].reason); // same cause, same words
    expect(lines[0].reason).toContain('no LLM api_key configured');
    expect(lines[0].reason).not.toMatch(/^Preflight:/);
    db.close();
  });
});
