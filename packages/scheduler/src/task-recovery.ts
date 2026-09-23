export type RecoveryPhase = 'execution' | 'completion' | 'verification' | 'collaboration';

export interface RecoveryIncident {
  attempt: number;
  agentId: string;
  phase: RecoveryPhase;
  reason: string;
  evidence?: string;
  candidateCommit?: string;
}

export type RecoveryAction = 'retry_same_agent' | 'reassign' | 'block';

export interface RecoveryDecision {
  action: RecoveryAction;
  attempt: number;
  retriesRemaining: number;
}

/**
 * TaskForge treats maxReworkCycles as the number of recovery attempts allowed
 * after the first failed execution. The first recovery keeps the same agent so
 * it can repair its own work with concrete failure evidence. A later recovery
 * reassigns the task to a different healthy agent. Once the budget is
 * exhausted, the task blocks instead of looping or silently delivering.
 */
export function decideTaskRecovery(
  reworkCount: number,
  maxReworkCycles: number,
): RecoveryDecision {
  const retriesRemaining = Math.max(0, maxReworkCycles - reworkCount);
  if (reworkCount > maxReworkCycles) {
    return { action: 'block', attempt: reworkCount, retriesRemaining: 0 };
  }
  if (reworkCount === 1) {
    return { action: 'retry_same_agent', attempt: reworkCount, retriesRemaining };
  }
  return { action: 'reassign', attempt: reworkCount, retriesRemaining };
}

function compact(value?: string, max = 1200): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\r/g, '').trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

export function formatRecoveryContext(incidents: RecoveryIncident[]): string {
  if (incidents.length === 0) return '';

  const recent = incidents.slice(-3);
  const lines = recent.flatMap((incident) => {
    const header =
      `Attempt ${incident.attempt} failed during ${incident.phase} with agent ${incident.agentId}: ${incident.reason}`;
    const evidence = compact(incident.evidence);
    const commit = incident.candidateCommit
      ? `Candidate state to repair: commit ${incident.candidateCommit}`
      : undefined;
    return [header, evidence ? `Evidence:\n${evidence}` : undefined, commit]
      .filter((line): line is string => Boolean(line));
  });

  return [
    'RECOVERY CONTEXT — authoritative evidence from previous attempts.',
    'Do not repeat the same attempt blindly. Diagnose the failure, repair the existing candidate when one is provided, and verify the specific failing condition before declaring completion.',
    ...lines,
  ].join('\n\n');
}

export function verificationEvidence(checks: Array<{
  command: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}>): string {
  return checks
    .map((check) => {
      const output = [compact(check.stderr, 700), compact(check.stdout, 700)]
        .filter(Boolean)
        .join('\n');
      return `$ ${check.command}\nexit=${check.exitCode}${output ? `\n${output}` : ''}`;
    })
    .join('\n\n');
}
