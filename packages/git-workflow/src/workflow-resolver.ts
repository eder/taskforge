import { GitWorkflowKind, GitWorkflowStrategy } from './workflow-types.js';
import { TrunkStrategy } from './strategies/trunk-strategy.js';
import { GithubFlowStrategy } from './strategies/github-flow-strategy.js';
import { GitflowStrategy } from './strategies/gitflow-strategy.js';
import { CurrentBranchStrategy } from './strategies/current-branch-strategy.js';

export interface GitWorkflowConfig {
  workflow: GitWorkflowKind;
  targetBranch?: string;
  branches: {
    production: string;
    development: string;
  };
}

export function createGitWorkflowStrategy(config: GitWorkflowConfig): GitWorkflowStrategy {
  switch (config.workflow) {
    case 'github-flow':
      return new GithubFlowStrategy(config.targetBranch ?? 'main');
    case 'gitflow':
      return new GitflowStrategy(config.branches.production, config.branches.development);
    case 'current-branch':
      return new CurrentBranchStrategy();
    case 'trunk':
    default:
      return new TrunkStrategy(config.targetBranch ?? 'main');
  }
}
