export function integrationBranchName(runId: string): string {
  const normalized = runId.startsWith('run-') ? runId : `run-${runId}`;
  return `taskforge/${normalized}`;
}
