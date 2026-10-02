import { TaskRepository, VerificationRepository, EventRepository } from '@taskforge/persistence';

/**
 * How much a finished run's changes were actually checked, in words that do not
 * overstate it. "Passed" is only meaningful when checks ran: a documentation
 * edit, or a project with no check commands, passes with nothing verified, and
 * the person about to apply the change must be able to tell the difference.
 */
export type TaskCheckState = 'verified' | 'no_checks' | 'not_applicable';

export interface TaskConfidence {
  taskId: string;
  title: string;
  state: TaskCheckState;
  /** Names of the checks that passed (tests, lint, ...). */
  checks: string[];
}

export type RunConfidenceHeadline = 'verified' | 'partly_verified' | 'unverified' | 'not_applicable';

export interface RunConfidence {
  headline: RunConfidenceHeadline;
  tasks: TaskConfidence[];
  /** Ids of agents whose independent review approved a change. */
  reviewedBy: string[];
}

const READ_ONLY_TYPES = new Set(['investigation', 'review', 'verification', 'analysis', 'report']);

function isReadOnlyTask(task: { type: string; contractJson?: string }): boolean {
  if (READ_ONLY_TYPES.has(task.type)) return true;
  try {
    const mode = (JSON.parse(task.contractJson ?? '{}') as { completionMode?: string }).completionMode;
    return mode === 'report' || mode === 'review';
  } catch {
    return false;
  }
}

export function describeRunConfidence(
  deps: { taskRepo: TaskRepository; verificationRepo: VerificationRepository; eventRepo: EventRepository },
  runId: string,
): RunConfidence {
  const results = new Map(
    deps.verificationRepo.listLatestByRun(runId).map((entry) => [entry.taskId, entry.result] as const),
  );
  const tasks: TaskConfidence[] = deps.taskRepo
    .listByRun(runId)
    .filter((t) => t.status === 'integrated')
    .map((t) => {
      const result = results.get(t.id);
      const passedChecks = (result?.checks ?? []).filter((c) => c.success).map((c) => c.name);
      let state: TaskCheckState;
      if (result && result.passed && passedChecks.length > 0) state = 'verified';
      else if (!result && isReadOnlyTask(t)) state = 'not_applicable';
      else state = 'no_checks';
      return { taskId: t.id, title: t.title, state, checks: [...new Set(passedChecks)] };
    });

  const changing = tasks.filter((t) => t.state !== 'not_applicable');
  const verified = changing.filter((t) => t.state === 'verified').length;
  const headline: RunConfidenceHeadline =
    changing.length === 0
      ? 'not_applicable'
      : verified === changing.length
        ? 'verified'
        : verified === 0
          ? 'unverified'
          : 'partly_verified';

  const reviewedBy = deps.eventRepo
    .listByRun(runId)
    .filter((e) => e.type === 'DUAL_REVIEW_APPROVED')
    .map((e) => String((e.payload as { reviewerId?: string }).reviewerId ?? 'a second agent'));

  return { headline, tasks, reviewedBy: [...new Set(reviewedBy)] };
}

/** Plain-text lines for the diff view and the apply confirmation (callers add color). */
export function formatRunConfidence(confidence: RunConfidence, goal?: string): string[] {
  const out: string[] = [];
  if (goal) out.push(`What it does: ${goal.split('\n').find((l) => l.trim())?.trim().slice(0, 160)}`);

  out.push('How it was checked:');
  if (confidence.headline === 'not_applicable') {
    out.push('  This run changed no files, so there was nothing to check.');
    return out;
  }
  for (const task of confidence.tasks) {
    if (task.state === 'not_applicable') continue;
    out.push(
      task.state === 'verified'
        ? `  ✔ ${task.taskId}  ${task.title}: ${task.checks.join(', ')} passed`
        : `  ⚠ ${task.taskId}  ${task.title}: no automated checks ran (a documentation-only change, or no check commands are configured)`,
    );
  }
  if (confidence.reviewedBy.length > 0) {
    out.push(`  ✔ independently reviewed and approved by ${confidence.reviewedBy.join(', ')}`);
  }
  if (confidence.headline === 'unverified') {
    out.push('Not verified: nothing was run against these changes, so "passed" says nothing about correctness. Read the diff before applying.');
  } else if (confidence.headline === 'partly_verified') {
    out.push('Partly verified: read the diff of the tasks marked ⚠ before applying.');
  }
  return out;
}
