import { CompletionFailureReason } from '@taskforge/shared';

export type TeamMemberFailureClass =
  | 'provider_unavailable'
  | 'task_failure'
  | 'permission_failure'
  | 'cancelled';

/**
 * Distinguishes a transient provider/capacity problem (quota exhaustion,
 * rate limiting) -- recoverable by reassigning the role to a healthy agent
 * -- from a genuine failure of the work itself (invalid analysis, denied
 * action, unmet acceptance criteria), which must stay subject to the
 * investigation policy rather than being silently retried with someone else.
 */
export function classifyTeamMemberFailure(
  completionReason: CompletionFailureReason | undefined,
  cancelled: boolean,
): TeamMemberFailureClass {
  if (cancelled) return 'cancelled';
  if (completionReason === 'PROVIDER_QUOTA_EXCEEDED') return 'provider_unavailable';
  if (completionReason === 'REQUIRED_ACTION_DENIED') return 'permission_failure';
  return 'task_failure';
}

export function isRecoverableTeamMemberFailure(failureClass: TeamMemberFailureClass): boolean {
  return failureClass === 'provider_unavailable';
}
