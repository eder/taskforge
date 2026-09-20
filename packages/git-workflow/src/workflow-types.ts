export type GitWorkflowKind = 'trunk' | 'github-flow' | 'gitflow' | 'current-branch';

export interface RepositoryContext {
  currentBranch: string;
  localBranches: string[];
}

export interface GitWorkflowStrategy {
  readonly kind: GitWorkflowKind;
  resolveTargetBranch(ctx: RepositoryContext, goalDescription: string): string;
}
