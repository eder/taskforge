import {
  TaskForgeDatabase,
  RunRepository,
  EventRepository,
  CostRepository,
} from '@taskforge/persistence';

/**
 * What the local history says about how TaskForge is doing in this project:
 * how often runs finish, what stops them, and what they cost. Computed only from
 * the project's own database; nothing is collected or sent anywhere.
 */
export interface InsightsReport {
  sinceDays: number;
  /** Runs started inside the window. */
  runs: number;
  byStatus: Record<string, number>;
  /** completed / (completed + failed + cancelled + abandoned); undefined when none ended. */
  completionRate?: number;
  /** Runs that were continued with `tf resume` at least once. */
  resumedRuns: number;
  /** Runs whose applied changes were later undone. */
  undoneRuns: number;
  /** Why work stopped, most frequent first. */
  stopCauses: Array<{ cause: string; label: string; count: number }>;
  tokens: { total: number; averagePerRun?: number; runsWithUsage: number };
  costUsd: { total: number; averagePerRun?: number };
}

const CAUSE_LABELS: Record<string, string> = {
  code_or_test: 'the change failed its checks after retries',
  verification_configuration: 'a check command that does not work for the project',
  environment: 'the environment could not run the checks',
  policy: 'a policy stopped the run',
  provider_quota: 'an agent ran out of quota',
  token_budget: 'the token budget was reached',
  scope_violation: 'an agent changed files outside its allowed scope',
  review_rejected: 'an independent reviewer rejected the change',
};

export function computeInsights(
  db: TaskForgeDatabase,
  options: { sinceDays?: number; now?: Date } = {},
): InsightsReport {
  const sinceDays = options.sinceDays ?? 30;
  const cutoff = (options.now ?? new Date()).getTime() - sinceDays * 86_400_000;
  const eventRepo = new EventRepository(db);
  const costRepo = new CostRepository(db);

  const runs = new RunRepository(db).listAll().filter((r) => new Date(r.createdAt).getTime() >= cutoff);

  const byStatus: Record<string, number> = {};
  const causes = new Map<string, number>();
  let resumedRuns = 0;
  let undoneRuns = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let runsWithUsage = 0;

  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;

    const events = eventRepo.listByRun(run.id);
    if (events.some((e) => e.type === 'RUN_RESUMED')) resumedRuns++;
    if (events.some((e) => e.type === 'DELIVERY_REVERTED')) undoneRuns++;
    const bump = (cause: string) => causes.set(cause, (causes.get(cause) ?? 0) + 1);
    for (const e of events) {
      if (e.type === 'TASK_RECOVERY_BLOCKED') {
        bump(String((e.payload as { failureClass?: string }).failureClass ?? 'code_or_test'));
      } else if (e.type === 'TOKEN_BUDGET_REACHED') bump('token_budget');
      else if (e.type === 'SCOPE_VIOLATION') bump('scope_violation');
      else if (e.type === 'DUAL_REVIEW_REJECTED') bump('review_rejected');
    }

    const cost = costRepo.getTotalCostByRun(run.id);
    if (cost.totalTokens > 0) {
      runsWithUsage++;
      totalTokens += cost.totalTokens;
      totalCost += cost.totalCostUsd;
    }
  }

  const ended = ['completed', 'failed', 'cancelled', 'abandoned'].reduce((n, s) => n + (byStatus[s] ?? 0), 0);
  return {
    sinceDays,
    runs: runs.length,
    byStatus,
    completionRate: ended > 0 ? (byStatus.completed ?? 0) / ended : undefined,
    resumedRuns,
    undoneRuns,
    stopCauses: [...causes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cause, count]) => ({ cause, label: CAUSE_LABELS[cause] ?? cause, count })),
    tokens: {
      total: totalTokens,
      averagePerRun: runsWithUsage > 0 ? Math.round(totalTokens / runsWithUsage) : undefined,
      runsWithUsage,
    },
    costUsd: {
      total: totalCost,
      averagePerRun: runsWithUsage > 0 ? totalCost / runsWithUsage : undefined,
    },
  };
}

export function formatInsights(report: InsightsReport): string[] {
  const n = (v: number) => v.toLocaleString('en-US');
  if (report.runs === 0) {
    return [`No runs in the last ${report.sinceDays} days.`];
  }
  const lines: string[] = [`Last ${report.sinceDays} days: ${report.runs} run${report.runs === 1 ? '' : 's'}`];
  const status = Object.entries(report.byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `${c} ${s}`)
    .join(', ');
  lines.push(`  Outcomes: ${status}`);
  if (report.completionRate !== undefined) {
    lines.push(`  Finished successfully: ${Math.round(report.completionRate * 100)}% of the runs that ended`);
  }
  if (report.resumedRuns > 0) lines.push(`  Needed tf resume: ${report.resumedRuns}`);
  if (report.undoneRuns > 0) lines.push(`  Applied, then undone: ${report.undoneRuns}`);
  if (report.stopCauses.length > 0) {
    lines.push('  What stopped work most:');
    for (const c of report.stopCauses.slice(0, 5)) lines.push(`    ${c.count}×  ${c.label}`);
  }
  if (report.tokens.runsWithUsage > 0) {
    lines.push(
      `  Tokens: ${n(report.tokens.total)} in total, about ${n(report.tokens.averagePerRun ?? 0)} per run (~$${(report.costUsd.averagePerRun ?? 0).toFixed(2)})`,
    );
  } else {
    lines.push('  Tokens: no usage was reported by the agents in this period.');
  }
  lines.push('  Computed from this project\'s local history only; nothing is sent anywhere.');
  return lines;
}
