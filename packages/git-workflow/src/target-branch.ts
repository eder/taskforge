import { RepositoryContext } from './workflow-types.js';

export interface ReconciledTarget {
  branch: string;
  /** Set when the configured target did not exist and another branch was chosen. */
  adjustedFrom?: string;
}

/**
 * Strategies resolve a *configured* target (default "main"), which may not
 * exist in the repository at hand (many repos use "master"; a feature-branch
 * workflow may have neither). Returns a target that exists locally:
 *
 *   1. the configured target, if it exists;
 *   2. the main/master counterpart, if that one exists;
 *   3. the branch the run started on, if it is a real branch;
 *   4. the configured target unchanged (delivery will report it clearly).
 */
export function reconcileTargetBranch(target: string, ctx: RepositoryContext): ReconciledTarget {
  const exists = (name: string) => ctx.localBranches.includes(name);
  if (exists(target)) return { branch: target };

  const counterpart = target === 'main' ? 'master' : target === 'master' ? 'main' : undefined;
  if (counterpart && exists(counterpart)) return { branch: counterpart, adjustedFrom: target };

  if (ctx.currentBranch && ctx.currentBranch !== 'HEAD' && exists(ctx.currentBranch)) {
    return { branch: ctx.currentBranch, adjustedFrom: target };
  }
  return { branch: target };
}
