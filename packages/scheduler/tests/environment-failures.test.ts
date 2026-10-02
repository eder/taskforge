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
