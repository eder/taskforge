import { GitWorkflowStrategy, RepositoryContext } from '../workflow-types.js';

export class CurrentBranchStrategy implements GitWorkflowStrategy {
  readonly kind = 'current-branch' as const;

  resolveTargetBranch(ctx: RepositoryContext): string {
    return ctx.currentBranch;
  }
}
