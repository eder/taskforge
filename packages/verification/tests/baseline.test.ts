import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner } from '../src/verification-runner.js';
import { extractFailureSignatures } from '../src/failure-signatures.js';

describe('extractFailureSignatures', () => {
  it('reads the failures each common runner prints, without their messages or timings', () => {
    expect(
      extractFailureSignatures(
        [
          'FAILED tests/test_a.py::test_x - AssertionError: 1 != 2',
          'ERROR test_uploads.py - RuntimeError: no LLM api_key configured',
          '8 errors in 25.20s',
        ].join('\n'),
      ),
    ).toEqual(['ERROR test_uploads.py', 'FAILED tests/test_a.py::test_x']);
    expect(extractFailureSignatures(' FAIL  src/a.test.ts > adds numbers\n ✓ ok')).toEqual(['FAIL src/a.test.ts > adds numbers']);
    expect(extractFailureSignatures('--- FAIL: TestSum (0.01s)\nFAIL\texample.com/pkg\t0.2s')).toEqual([
      '--- FAIL: TestSum',
      'FAIL example.com/pkg 0.2s',
    ].sort());
    expect(extractFailureSignatures('ok 1 - fine\nnot ok 2 - broken thing')).toEqual(['not ok broken thing']);
    // Node's default reporter: a decimal timing that changes on every run must not change the identity.
    expect(extractFailureSignatures('✖ greets by name (1.027875ms)\nℹ fail 1\n✖ failing tests:')).toEqual(['✖ greets by name']);
    expect(extractFailureSignatures('✖ greets by name (9.5ms)')).toEqual(['✖ greets by name']);
    expect(extractFailureSignatures('test parser::handles_empty ... FAILED')).toEqual(['test parser::handles_empty ... FAILED']);
  });

  it('ignores colours, passing lines and output in a format it does not know', () => {
    expect(extractFailureSignatures('\u001b[31mFAILED\u001b[0m tests/a.py::t')).toEqual(['FAILED tests/a.py::t']);
    expect(extractFailureSignatures('everything went wrong in a way no runner prints')).toEqual([]);
    expect(extractFailureSignatures('PASSED tests/a.py::t')).toEqual([]);
  });

  it('does not mistake a renumbered TAP test for a new failure', () => {
    expect(extractFailureSignatures('not ok 2 - broken')).toEqual(extractFailureSignatures('not ok 7 - broken'));
  });

  it('is stable: the same failures in a different order are the same set', () => {
    expect(extractFailureSignatures('FAILED b\nFAILED a')).toEqual(extractFailureSignatures('FAILED a\nFAILED b'));
  });
});

describe('judging a check against how it behaved before the change', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-baseline-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = () => {
    const c = getDefaultConfig();
    c.verification.tests = false;
    c.verification.lint = false;
    c.verification.typecheck = false;
    return c;
  };
  // A suite with two old failures, plus one more when ./new exists.
  const SUITE = `node -e "const fs=require('fs');console.log('FAILED tests/old.py::test_a - boom');console.log('FAILED tests/old.py::test_b - boom');if(fs.existsSync('new'))console.log('FAILED tests/new.py::test_c - boom');process.exit(1)"`;
  const verify = (runner: VerificationRunner, command = SUITE) =>
    runner.verify({ taskId: 'T', runId: 'r', worktreePath: dir, config: config(), taskType: 'implementation', explicitCommands: [command] });
  const baseline = { [SUITE]: { failed: true, signatures: ['FAILED tests/old.py::test_a', 'FAILED tests/old.py::test_b'] } };

  it('passes when the only failures are the ones that were already there, and says so', async () => {
    const runner = new VerificationRunner(undefined, undefined, 0);
    runner.setBaseline('r', baseline);
    const result = await verify(runner);
    expect(result.passed).toBe(true);
    expect(result.checks[0].baselineOnly).toBe(true);
    expect(result.notes?.join(' ')).toContain('2 failure(s) already there before the change, none new');
  });

  it('fails on a new failure and shows only the new one', async () => {
    fs.writeFileSync(path.join(dir, 'new'), '');
    const runner = new VerificationRunner(undefined, undefined, 0);
    runner.setBaseline('r', baseline);
    const result = await verify(runner);
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('New failures compared with before the change (2 already failing are ignored)');
    expect(result.failureReason).toContain('- FAILED tests/new.py::test_c');
    expect(result.failureReason).not.toMatch(/- FAILED tests\/old\.py/);
  });

  it('judges by exit code, as before, with no baseline or with output it cannot read', async () => {
    const runner = new VerificationRunner(undefined, undefined, 0);
    expect((await verify(runner)).passed).toBe(false); // no baseline
    runner.setBaseline('r', baseline);
    const opaque = `node -e "console.log('something broke in a custom format');process.exit(1)"`;
    runner.setBaseline('r', { [opaque]: { failed: true, signatures: [] } });
    expect((await verify(runner, opaque)).passed).toBe(false); // nothing to compare
  });

  it('a baseline that passed gives no leniency: any failure is new', async () => {
    const runner = new VerificationRunner(undefined, undefined, 0);
    runner.setBaseline('r', { [SUITE]: { failed: false, signatures: [] } });
    expect((await verify(runner)).passed).toBe(false);
  });
});
