import { TaskRepository, EventRepository } from '@taskforge/persistence';
import { describeRunFailures, environmentFixesFor } from './run-failure-report.js';
import {
  applyEnvironmentFixes,
  describeFix,
  type AppliedFixes,
  type EnvironmentFix,
} from './environment-repair.js';

export interface RunRepair {
  /** What TaskForge found it can fix for this run (empty: nothing it can do alone). */
  fixes: EnvironmentFix[];
  /** Human descriptions of `fixes`, in order. */
  descriptions: string[];
  /** Present once the fixes were applied. */
  applied?: AppliedFixes;
}

/** What `tf fix` would do for a run that did not complete, without doing it. */
export function planRunRepair(
  deps: { taskRepo: TaskRepository; eventRepo: EventRepository },
  repoRoot: string,
  runId: string,
): RunRepair {
  const fixes = environmentFixesFor(describeRunFailures(deps, runId), repoRoot);
  return { fixes, descriptions: fixes.map(describeFix) };
}

/** Plans and applies the repair. The caller continues the run when nothing failed. */
export async function repairRun(
  deps: { taskRepo: TaskRepository; eventRepo: EventRepository },
  repoRoot: string,
  runId: string,
): Promise<RunRepair> {
  const plan = planRunRepair(deps, repoRoot, runId);
  if (plan.fixes.length === 0) return plan;
  return { ...plan, applied: await applyEnvironmentFixes(repoRoot, plan.fixes) };
}
