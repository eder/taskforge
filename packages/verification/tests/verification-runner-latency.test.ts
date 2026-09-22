import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner } from '../src/verification-runner.js';

describe('VerificationRunner latency policy', () => {
  it('does not rerun test/lint/typecheck for a read-only review task', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-review-verification-'));

    try {
      fs.writeFileSync(
        path.join(worktree, 'package.json'),
        JSON.stringify(
          {
            scripts: {
              test: 'node -e "process.exit(99)"',
              lint: 'node -e "process.exit(99)"',
              typecheck: 'node -e "process.exit(99)"',
            },
          },
          null,
          2,
        ),
      );

      const config = getDefaultConfig();
      config.verification.tests = true;
      config.verification.lint = true;
      config.verification.typecheck = true;

      const runner = new VerificationRunner();
      const result = await runner.verify({
        taskId: 'TASK-REVIEW',
        runId: 'run-review',
        worktreePath: worktree,
        config,
        taskType: 'review',
      });

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([]);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('records a failing explicit command as successful baseline observation', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-baseline-verification-'));

    try {
      const runner = new VerificationRunner();
      const result = await runner.verify({
        taskId: 'TASK-BASELINE',
        runId: 'run-baseline',
        worktreePath: worktree,
        config: getDefaultConfig(),
        taskType: 'testing',
        explicitCommands: ['node -p process.exitCode=7'],
        expectation: 'observe',
      });

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].exitCode).toBe(7);
      expect(result.checks[0].success).toBe(false);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('fails when an explicit verification command is required to pass', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pass-verification-'));

    try {
      const runner = new VerificationRunner();
      const result = await runner.verify({
        taskId: 'TASK-VERIFY',
        runId: 'run-verify',
        worktreePath: worktree,
        config: getDefaultConfig(),
        taskType: 'testing',
        explicitCommands: ['node -p process.exitCode=7'],
        expectation: 'pass',
      });

      expect(result.passed).toBe(false);
      expect(result.checks[0].exitCode).toBe(7);
      expect(result.failureReason).toContain('exit code 7');
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});
