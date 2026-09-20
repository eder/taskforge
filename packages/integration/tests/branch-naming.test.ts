import { describe, it, expect } from 'vitest';
import { integrationBranchName } from '../src/branch-naming.js';

describe('integrationBranchName', () => {
  it('does not double-prefix a runId that already starts with run-', () => {
    expect(integrationBranchName('run-1789860407218')).toBe('taskforge/run-1789860407218');
  });

  it('prefixes a bare runId with run-', () => {
    expect(integrationBranchName('1789860407218')).toBe('taskforge/run-1789860407218');
  });
});
