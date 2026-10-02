export type RecoveryPhase =
  | 'execution'
  | 'completion'
  | 'verification'
  | 'collaboration'
  | 'review';

export type RecoveryFailureClass =
  | 'code_or_test'
  | 'provider_quota'
  | 'verification_configuration'
  | 'environment'
  | 'policy';

export interface RecoveryIncident {
  attempt: number;
  agentId: string;
  phase: RecoveryPhase;
  failureClass: RecoveryFailureClass;
  reason: string;
  evidence?: string;
  candidateCommit?: string;
}

/**
 * Work an agent produced that did not reach the run branch. It is kept on a
 * named branch so it is never stranded, and `tf resume` reuses it: when the
 * blocker was configuration, environment or policy (not the quality of the
 * work), only the checks run again, with no agent call.
 */
export interface PreservedCandidate {
  commit: string;
  branch: string;
  phase: string;
  failureClass: RecoveryFailureClass;
  reason: string;
  evidence?: string;
  agentId?: string;
}

/** Blockers that say nothing about the work itself. */
export function candidateNeedsNoAgent(candidate: PreservedCandidate): boolean {
  return (
    candidate.failureClass === 'verification_configuration' ||
    candidate.failureClass === 'environment' ||
    candidate.failureClass === 'policy'
  );
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
  failureClass: RecoveryFailureClass = 'code_or_test',
): RecoveryDecision {
  const retriesRemaining = Math.max(0, maxReworkCycles - reworkCount);

  if (
    failureClass === 'verification_configuration' ||
    failureClass === 'environment' ||
    failureClass === 'policy'
  ) {
    return { action: 'block', attempt: reworkCount, retriesRemaining };
  }

  if (failureClass === 'provider_quota') {
    return { action: 'reassign', attempt: reworkCount, retriesRemaining };
  }

  if (reworkCount > maxReworkCycles) {
    return { action: 'block', attempt: reworkCount, retriesRemaining: 0 };
  }
  if (reworkCount === 1) {
    return { action: 'retry_same_agent', attempt: reworkCount, retriesRemaining };
  }
  return { action: 'reassign', attempt: reworkCount, retriesRemaining };
}

export function recoveryConsumesRework(failureClass: RecoveryFailureClass): boolean {
  return failureClass === 'code_or_test';
}

/**
 * Checks that fail because the environment they run in lacks something the
 * project needs: a service that is not running, a secret that was withheld, a
 * dependency that is not installed. The agent's change is not the cause, so
 * retrying the agent cannot help.
 */
const ENVIRONMENT_PATTERNS: RegExp[] = [
  /connection refused|econnrefused|connect call failed|could not connect to (?:server|database)/,
  /\[errno (?:61|111)\]/, // connection refused on macOS / Linux
  /temporary failure in name resolution|getaddrinfo (?:enotfound|eai_again)/,
  /no [\w ]{0,30}api[_ ]?key[\w ]{0,20}(?:configured|set|found|provided)/,
  /(?:missing|unset|not set|not defined|required)[\w ,:'"-]{0,40}(?:api[_ ]?key|environment variable)/,
  /modulenotfounderror|cannot find module '(?!\.)/,
];

function looksLikeEnvironmentFailure(text: string): boolean {
  const value = text.toLowerCase();
  if (ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return (
    value.includes('command not found') ||
    value.includes('no such file or directory') ||
    value.includes('toolchain') ||
    value.includes('developer directory') ||
    value.includes('swift-plugin-server') ||
    value.includes('swiftuimacros') ||
    value.includes('external macro implementation') ||
    value.includes('index.lock') ||
    value.includes('operation not permitted') ||
    value.includes('permission denied') ||
    value.includes('read-only file system')
  );
}

export function classifyExecutionFailure(
  completionReason?: string,
  evidence?: string,
): RecoveryFailureClass {
  if (completionReason === 'PROVIDER_QUOTA_EXCEEDED') return 'provider_quota';
  const text = `${completionReason ?? ''}\n${evidence ?? ''}`;
  return looksLikeEnvironmentFailure(text) ? 'environment' : 'code_or_test';
}

const COMPLETION_MESSAGES: Record<string, string> = {
  NO_CHANGES_PRODUCED:
    "The agent finished without changing any file, but this task requires a change. The work may already exist (check the run's base commit and other branches) or the instructions may be unclear.",
  REQUIRED_ACTION_DENIED: 'A permission the agent needed was denied by the permission policy.',
  UNRESOLVED_INTERACTION: 'The agent was waiting for a question or approval that was never answered.',
  HARNESS_FAILED: 'The agent CLI itself failed (crash, authentication or configuration problem).',
  EMPTY_PROVIDER_RESULT: 'The agent returned an empty result.',
  INVALID_PROVIDER_RESULT: 'The agent returned a result TaskForge could not read.',
  VERIFICATION_FAILED: 'The change failed automated verification.',
  ACCEPTANCE_NOT_MET: "The result did not meet the task's acceptance criteria.",
  PROVIDER_QUOTA_EXCEEDED: 'The provider ran out of quota.',
};

/** Plain-language reason for a completion-gate code (the code itself means nothing to a user). */
export function describeCompletionFailure(code?: string): string {
  if (!code) return 'The completion gate rejected the attempt';
  return COMPLETION_MESSAGES[code] ?? code;
}

export function classifyCompletionFailure(
  failureReason?: string,
  evidence?: string,
): RecoveryFailureClass {
  if (failureReason === 'REQUIRED_ACTION_DENIED') return 'policy';
  const text = `${failureReason ?? ''}\n${evidence ?? ''}`;
  return looksLikeEnvironmentFailure(text) ? 'environment' : 'code_or_test';
}

/**
 * Output that says the verification command itself is unsuitable for this
 * project (wrong runner, missing plugin, bad arguments), as opposed to the
 * change failing a check. Retrying the agent cannot fix these.
 */
const VERIFICATION_TOOL_MISUSE = [
  'not natively supported', // pytest without an asyncio plugin
  'no tests ran',
  'no tests collected',
  'unrecognized arguments',
  'file or directory not found',
  'no module named pytest',
  'with exit code 127', // command not found
  'with exit code 126', // not executable
];

export function classifyVerificationFailure(reason?: string, evidence?: string): RecoveryFailureClass {
  const text = `${reason ?? ''}\n${evidence ?? ''}`.toLowerCase();
  if (
    text.includes('no verification checks were executed') ||
    VERIFICATION_TOOL_MISUSE.some((pattern) => text.includes(pattern))
  ) {
    return 'verification_configuration';
  }
  if (looksLikeEnvironmentFailure(text)) {
    return 'environment';
  }
  return 'code_or_test';
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
      `Attempt ${incident.attempt} failed during ${incident.phase} [${incident.failureClass}] with agent ${incident.agentId}: ${incident.reason}`;
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
