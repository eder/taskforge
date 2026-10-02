import { describe, it, expect } from 'vitest';
import { reconcileTargetBranch } from '../src/target-branch.js';

const ctx = (currentBranch: string, localBranches: string[]) => ({ currentBranch, localBranches });

describe('reconcileTargetBranch', () => {
  it('keeps a target that exists', () => {
    expect(reconcileTargetBranch('main', ctx('feature/x', ['main', 'feature/x']))).toEqual({ branch: 'main' });
  });

  it('maps main to master (and back) when only the counterpart exists', () => {
    expect(reconcileTargetBranch('main', ctx('master', ['master']))).toEqual({
      branch: 'master',
      adjustedFrom: 'main',
    });
    expect(reconcileTargetBranch('master', ctx('main', ['main']))).toEqual({
      branch: 'main',
      adjustedFrom: 'master',
    });
  });

  it('falls back to the starting branch when neither main nor master exists', () => {
    expect(reconcileTargetBranch('main', ctx('trunk', ['trunk']))).toEqual({
      branch: 'trunk',
      adjustedFrom: 'main',
    });
  });

  it('does not pick a detached HEAD, and leaves the target unchanged', () => {
    expect(reconcileTargetBranch('main', ctx('HEAD', []))).toEqual({ branch: 'main' });
  });
});
