import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner } from '../src/verification-runner.js';

describe('a failed verification check says what failed', () => {
  const verify = (cmd: string) =>
    new VerificationRunner().verify({
      taskId: 'T',
      runId: 'R',
      worktreePath: process.cwd(),
      config: getDefaultConfig(),
      explicitCommands: [cmd],
    });

  it('includes the exit code, the command and the last lines of output', async () => {
    const result = await verify('echo first; echo "ModuleNotFoundError: No module named boto3" >&2; exit 2');
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("Check 'explicit-1' failed with exit code 2");
    expect(result.failureReason).toContain('Command: echo first');
    expect(result.failureReason).toContain('ModuleNotFoundError: No module named boto3');
  });

  it('marks a timed-out check as such', async () => {
    const config = getDefaultConfig();
    config.verification.commandTimeoutSeconds = 1;
    const result = await new VerificationRunner().verify({
      taskId: 'T',
      runId: 'R',
      worktreePath: process.cwd(),
      config,
      explicitCommands: ['sleep 20'],
    });
    expect(result.failureReason).toContain('(timed out)');
  });

  it('keeps the original prefix so recovery classification still works', async () => {
    const result = await verify('exit 1');
    expect(result.failureReason?.startsWith("Check 'explicit-1' failed with exit code 1")).toBe(true);
  });
});
