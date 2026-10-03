import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner, isTransientVerificationFailure } from '../src/verification-runner.js';

describe('transient verification failures', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-transient-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = () => {
    const c = getDefaultConfig();
    c.verification.tests = false;
    c.verification.lint = false;
    c.verification.typecheck = false;
    return c;
  };
  // Fails once with a lock error, then passes.
  const flaky = `node -e "const fs=require('fs');if(!fs.existsSync('seen')){fs.writeFileSync('seen','1');console.error('fatal: Unable to create index.lock');process.exit(1)}"`;
  const alwaysBroken = `node -e "console.error('AssertionError: expected 1 to be 2');process.exit(1)"`;

  const verify = (runner: VerificationRunner, command: string) =>
    runner.verify({
      taskId: 'T1',
      runId: 'run-1',
      worktreePath: dir,
      config: config(),
      taskType: 'implementation',
      explicitCommands: [command],
    });

  it('re-runs once and passes when the first failure was a transient lock', async () => {
    const result = await verify(new VerificationRunner(undefined, undefined, 5), flaky);
    expect(result.passed).toBe(true);
  });

  it('does not retry a real failure, and never when the retry is disabled', async () => {
    const real = await verify(new VerificationRunner(undefined, undefined, 5), alwaysBroken);
    expect(real.passed).toBe(false);
    fs.rmSync(path.join(dir, 'seen'), { force: true });
    const disabled = await verify(new VerificationRunner(undefined, undefined, 0), flaky);
    expect(disabled.passed).toBe(false);
  });

  it('classifies only machine-level failures as transient', () => {
    const fail = (stderr: string, failureReason = '') => ({
      passed: false,
      failureReason,
      checks: [{ name: 'x', command: 'x', exitCode: 1, stdout: '', stderr, durationMs: 1, success: false }],
    });
    expect(isTransientVerificationFailure(fail('ECONNRESET while fetching'))).toBe(true);
    expect(isTransientVerificationFailure(fail('Connection reset by peer'))).toBe(true);
    expect(isTransientVerificationFailure(fail('sh: pytest: command not found'))).toBe(false);
    expect(isTransientVerificationFailure(fail('AssertionError'))).toBe(false);
    expect(isTransientVerificationFailure({ passed: true, checks: [] })).toBe(false);
  });
});

describe('check evidence names the cause', () => {
  it('runs with wide terminal columns and keeps the earlier lines that say what went wrong', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-evidence-'));
    try {
      const c = getDefaultConfig();
      c.verification.tests = false;
      c.verification.lint = false;
      c.verification.typecheck = false;
      // Prints the width it was given, an early error line, then only summary lines.
      const cmd = `node -e "console.log('FileNotFoundError: [Errno 2] No such file or directory: \\'audio/sample.wav\\''); console.log('COLUMNS=' + process.env.COLUMNS); for (let i=0;i<8;i++) console.log('summary line ' + i); process.exit(2)"`;
      const result = await new VerificationRunner(undefined, undefined, 0).verify({
        taskId: 'T',
        runId: 'r',
        worktreePath: dir,
        config: c,
        taskType: 'implementation',
        explicitCommands: [cmd],
      });
      expect(result.passed).toBe(false);
      expect(result.failureReason).toContain('Errors seen:');
      expect(result.failureReason).toContain("audio/sample.wav"); // not cut off, though it is not in the last lines
      expect(result.checks[0].stdout).toContain('COLUMNS=220');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
