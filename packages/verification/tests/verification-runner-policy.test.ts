import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner } from '../src/verification-runner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function worktree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-verification-policy-'));
  roots.push(root);
  return root;
}

describe('VerificationRunner no-check policy', () => {
  it('allows zero checks when repository verification is explicitly disabled', async () => {
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const result = await new VerificationRunner().verify({
      taskId: 'TASK-1',
      runId: 'run-1',
      worktreePath: worktree(),
      config,
      taskType: 'implementation',
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([]);
  });

  it('fails closed when verification is enabled but no executable checks exist', async () => {
    const config = getDefaultConfig();

    const result = await new VerificationRunner().verify({
      taskId: 'TASK-2',
      runId: 'run-2',
      worktreePath: worktree(),
      config,
      taskType: 'implementation',
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('No verification checks were executed');
  });

  it('fails closed for an explicit verification request with no commands', async () => {
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const result = await new VerificationRunner().verify({
      taskId: 'TASK-3',
      runId: 'run-3',
      worktreePath: worktree(),
      config,
      taskType: 'testing',
      explicitCommands: [],
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('No verification checks were executed');
  });
});
