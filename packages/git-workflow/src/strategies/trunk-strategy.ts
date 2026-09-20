import { GitWorkflowStrategy } from '../workflow-types.js';

export class TrunkStrategy implements GitWorkflowStrategy {
  readonly kind = 'trunk' as const;

  constructor(private targetBranch: string = 'main') {}

  resolveTargetBranch(): string {
    return this.targetBranch;
  }
}
