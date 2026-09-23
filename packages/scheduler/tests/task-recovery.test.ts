import { describe, expect, it } from 'vitest';
import {
  classifyCompletionFailure,
  classifyExecutionFailure,
  classifyVerificationFailure,
  decideTaskRecovery,
  formatRecoveryContext,
  verificationEvidence,
} from '../src/task-recovery.js';

describe('task recovery policy', () => {
  it('retries the same agent first, then reassigns, then blocks', () => {
    expect(decideTaskRecovery(1, 2).action).toBe('retry_same_agent');
    expect(decideTaskRecovery(2, 2).action).toBe('reassign');
    expect(decideTaskRecovery(3, 2).action).toBe('block');
  });

  it('blocks immediately when rework is disabled', () => {
    expect(decideTaskRecovery(1, 0).action).toBe('block');
  });

  it('blocks control-plane verification configuration failures without retrying an agent', () => {
    expect(decideTaskRecovery(0, 2, 'verification_configuration').action).toBe('block');
  });

  it('reassigns provider quota failures without requiring a code rework attempt', () => {
    expect(decideTaskRecovery(0, 2, 'provider_quota').action).toBe('reassign');
  });


  it('injects concrete prior failure evidence into the next attempt', () => {
    const text = formatRecoveryContext([
      {
        attempt: 1,
        agentId: 'codex',
        phase: 'verification',
        failureClass: 'code_or_test',
        reason: 'xcodebuild failed',
        evidence: 'Cannot convert value of type Commitment',
        candidateCommit: 'abc123',
      },
    ]);

    expect(text).toContain('RECOVERY CONTEXT');
    expect(text).toContain('xcodebuild failed');
    expect(text).toContain('Cannot convert value');
    expect(text).toContain('abc123');
  });

  it('classifies provider quota separately from implementation failure', () => {
    expect(classifyExecutionFailure('PROVIDER_QUOTA_EXCEEDED', 'usage limit')).toBe(
      'provider_quota',
    );
  });

  it('classifies missing verification as control-plane configuration failure', () => {
    expect(
      classifyVerificationFailure(
        'No verification checks were executed for a code-changing task.',
      ),
    ).toBe('verification_configuration');
  });

  it('classifies Xcode macro/tooling failures as environment failures', () => {
    expect(
      classifyVerificationFailure(
        'xcodebuild failed',
        'SwiftUIMacros.StateMacro could not load swift-plugin-server',
      ),
    ).toBe('environment');
  });

  it('classifies worktree index.lock permission failures as environment failures', () => {
    expect(
      classifyCompletionFailure(
        'NO_CHANGES_PRODUCED',
        'fatal: Unable to create .git/worktrees/task/index.lock: Operation not permitted',
      ),
    ).toBe('environment');
  });

  it('formats failing verification commands and output', () => {
    const text = verificationEvidence([
      {
        command: 'pnpm test',
        exitCode: 1,
        stderr: '1 failing test',
      },
    ]);

    expect(text).toContain('$ pnpm test');
    expect(text).toContain('exit=1');
    expect(text).toContain('1 failing test');
  });
});
