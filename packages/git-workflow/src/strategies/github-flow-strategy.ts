import { GitWorkflowStrategy } from '../workflow-types.js';

/**
 * Resolves to the same fixed target branch as TrunkStrategy. The distinction
 * from trunk is one of intent/config documentation (github-flow pairs
 * naturally with `delivery.mode: pull_request`) rather than branch
 * resolution mechanics — the two config axes stay independent.
 */
export class GithubFlowStrategy implements GitWorkflowStrategy {
  readonly kind = 'github-flow' as const;

  constructor(private targetBranch: string = 'main') {}

  resolveTargetBranch(): string {
    return this.targetBranch;
  }
}
