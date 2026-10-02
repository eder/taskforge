import { describe, it, expect } from 'vitest';
import {
  classifyVerificationFailure,
  candidateNeedsNoAgent,
  decideTaskRecovery,
  type PreservedCandidate,
} from '../src/task-recovery.js';

describe('verification tool misuse is a configuration problem, not a code failure', () => {
  it.each([
    "Check 'explicit-1' failed with exit code 2\nLast output:\nFAILED t.py::t - Failed: async def functions are not natively supported.",
    "Check 'explicit-1' failed with exit code 5\nLast output:\nno tests ran in 0.01s",
    "Check 'explicit-1' failed with exit code 4\nLast output:\nERROR: file or directory not found: tests/",
    "Check 'explicit-1' failed with exit code 127\nLast output:\nsh: pytest: not found",
    "Check 'explicit-1' failed with exit code 2\nLast output:\nerror: unrecognized arguments: --foo",
    'No verification checks were executed for a code-changing task.',
  ])('classifies %#', (reason) => {
    expect(classifyVerificationFailure(reason)).toBe('verification_configuration');
    expect(decideTaskRecovery(0, 2, 'verification_configuration').action).toBe('block');
  });

  it('a genuine failing assertion is still a code failure, so the agent may retry', () => {
    expect(
      classifyVerificationFailure("Check 'explicit-1' failed with exit code 1\nLast output:\nAssertionError: expected 3 to equal 4"),
    ).toBe('code_or_test');
  });
});

describe('candidateNeedsNoAgent', () => {
  const base: PreservedCandidate = { commit: 'abc', branch: 'b', phase: 'verification', failureClass: 'code_or_test', reason: 'r' };
  it('only blockers that say nothing about the work skip the agent', () => {
    expect(candidateNeedsNoAgent({ ...base, failureClass: 'verification_configuration' })).toBe(true);
    expect(candidateNeedsNoAgent({ ...base, failureClass: 'environment' })).toBe(true);
    expect(candidateNeedsNoAgent({ ...base, failureClass: 'policy' })).toBe(true);
    expect(candidateNeedsNoAgent({ ...base, failureClass: 'code_or_test' })).toBe(false);
  });
});

import { describeCompletionFailure } from '../src/task-recovery.js';

describe('describeCompletionFailure', () => {
  it('turns every completion code into a sentence, and never returns a bare code', () => {
    for (const code of [
      'NO_CHANGES_PRODUCED',
      'REQUIRED_ACTION_DENIED',
      'UNRESOLVED_INTERACTION',
      'HARNESS_FAILED',
      'EMPTY_PROVIDER_RESULT',
      'INVALID_PROVIDER_RESULT',
      'VERIFICATION_FAILED',
      'ACCEPTANCE_NOT_MET',
      'PROVIDER_QUOTA_EXCEEDED',
    ]) {
      const text = describeCompletionFailure(code);
      expect(text).not.toBe(code);
      expect(text.length).toBeGreaterThan(20);
    }
    expect(describeCompletionFailure(undefined)).toContain('rejected');
    expect(describeCompletionFailure('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
