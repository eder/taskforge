import { GitWorkflowStrategy, RepositoryContext } from '../workflow-types.js';

const HOTFIX_PATTERN = /\b(hotfix|urgent|critical|incident|production (bug|crash|incident))\b/i;

export class GitflowStrategy implements GitWorkflowStrategy {
  readonly kind = 'gitflow' as const;

  constructor(
    private production: string = 'main',
    private development: string = 'develop',
  ) {}

  resolveTargetBranch(ctx: RepositoryContext, goalDescription: string): string {
    const isHotfix = HOTFIX_PATTERN.test(goalDescription);
    if (isHotfix) return this.production;

    // Fall back to production if the development branch doesn't actually exist.
    if (!ctx.localBranches.includes(this.development)) return this.production;

    return this.development;
  }
}
