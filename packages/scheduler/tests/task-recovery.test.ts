import { describe, expect, it } from 'vitest';
import {
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

  it('injects concrete prior failure evidence into the next attempt', () => {
    const text = formatRecoveryContext([
      {
        attempt: 1,
        agentId: 'codex',
        phase: 'verification',
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
