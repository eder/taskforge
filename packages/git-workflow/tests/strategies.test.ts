import { describe, it, expect } from 'vitest';
import { createGitWorkflowStrategy } from '../src/workflow-resolver.js';
import { RepositoryContext } from '../src/workflow-types.js';

const ctx = (overrides: Partial<RepositoryContext> = {}): RepositoryContext => ({
  currentBranch: 'feature/x',
  localBranches: ['main', 'feature/x'],
  ...overrides,
});

describe('Git workflow strategies', () => {
  it('trunk resolves to the configured target branch, defaulting to main', () => {
    const strategy = createGitWorkflowStrategy({
      workflow: 'trunk',
      branches: { production: 'main', development: 'develop' },
    });
    expect(strategy.resolveTargetBranch(ctx(), 'add a feature')).toBe('main');

    const customStrategy = createGitWorkflowStrategy({
      workflow: 'trunk',
      targetBranch: 'release',
      branches: { production: 'main', development: 'develop' },
    });
    expect(customStrategy.resolveTargetBranch(ctx(), 'add a feature')).toBe('release');
  });

  it('github-flow resolves the same way as trunk', () => {
    const strategy = createGitWorkflowStrategy({
      workflow: 'github-flow',
      branches: { production: 'main', development: 'develop' },
    });
    expect(strategy.resolveTargetBranch(ctx(), 'add a feature')).toBe('main');
  });

  it('current-branch resolves to whatever branch the run started on', () => {
    const strategy = createGitWorkflowStrategy({
      workflow: 'current-branch',
      branches: { production: 'main', development: 'develop' },
    });
    expect(strategy.resolveTargetBranch(ctx({ currentBranch: 'feature/commitments' }), 'add a feature')).toBe(
      'feature/commitments',
    );
  });

  it('gitflow targets development for a normal goal', () => {
    const strategy = createGitWorkflowStrategy({
      workflow: 'gitflow',
      branches: { production: 'main', development: 'develop' },
    });
    expect(
      strategy.resolveTargetBranch(ctx({ localBranches: ['main', 'develop'] }), 'add commitment intelligence'),
    ).toBe('develop');
  });

  it('gitflow targets production for a hotfix-worded goal', () => {
    const strategy = createGitWorkflowStrategy({
      workflow: 'gitflow',
      branches: { production: 'main', development: 'develop' },
    });
    expect(
      strategy.resolveTargetBranch(
        ctx({ localBranches: ['main', 'develop'] }),
        'hotfix the checkout crash in production',
      ),
    ).toBe('main');
  });

  it('gitflow falls back to production when development does not exist locally', () => {
    const strategy = createGitWorkflowStrategy({
      workflow: 'gitflow',
      branches: { production: 'main', development: 'develop' },
    });
    expect(strategy.resolveTargetBranch(ctx({ localBranches: ['main'] }), 'add a feature')).toBe('main');
  });
});
