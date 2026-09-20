import { GitService } from '@taskforge/workspace';
import { GitWorkflowKind } from './workflow-types.js';

export interface WorkflowSuggestion {
  suggested: GitWorkflowKind;
  reason: string;
}

export async function detectWorkflowSuggestion(
  gitService: GitService,
  repoRoot: string,
): Promise<WorkflowSuggestion | undefined> {
  const branches = await gitService.listLocalBranches(repoRoot);
  const hasMain = branches.includes('main') || branches.includes('master');
  const hasDevelop = branches.includes('develop');

  if (hasMain && hasDevelop) {
    return {
      suggested: 'gitflow',
      reason: "found both a main/master branch and a develop branch",
    };
  }

  return undefined;
}
