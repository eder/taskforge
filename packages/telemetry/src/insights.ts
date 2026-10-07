import {
  TaskForgeDatabase,
  RunRepository,
  EventRepository,
  CostRepository,
  ExecutionRepository,
  ExecutionRecord,
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
  /** How each agent did, most executions first. */
  agents: AgentInsight[];
  /**
   * How much the work of different tasks overlapped in time, over runs where at
   * least two tasks ran: seconds of task work divided by wall-clock seconds
   * (1 = one task at a time; a bit below 1 means idle gaps between tasks). Agents working together on one task are counted
   * once, so redundancy is not mistaken for parallel work.
   */
  parallelism?: { factor: number; runs: number };
  /**
   * Where the wall-clock time of finished runs went, over runs that used a real agent. The slices do not
   * overlap: a moment counts as agent work if any agent was running, else as verification if a check was
   * running, else as TaskForge's own steps (preflight, routing, setting up worktrees, integrating, waiting).
   */
  time?: TimeBreakdown;
}

export interface TimeBreakdown {
  runs: number;
  totalSeconds: number;
  agentSeconds: number;
  verificationSeconds: number;
  /** What is left: everything that was neither an agent working nor a check running. */
  otherSeconds: number;
  /** Mean time from the run starting to the first agent starting. */
  averageSecondsBeforeFirstAgent: number;
  /** Mean time from the last agent finishing to the run ending (checks, integration, wrap-up). */
  averageSecondsAfterLastAgent: number;
}

export interface AgentInsight {
  agentId: string;
  executions: number;
  succeeded: number;
  failed: number;
  /** Mean duration of the finished executions. */
  averageSeconds?: number;
  tokens: number;
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

const seconds = (iso: string): number => new Date(iso).getTime() / 1000;

/** Task-level work and wall time of a run, or undefined when fewer than two tasks ran. */
function taskOverlap(executions: ExecutionRecord[]): { work: number; wall: number } | undefined {
  const byTask = new Map<string, { start: number; end: number }>();
  for (const e of executions) {
    if (!e.finishedAt) continue;
    const start = seconds(e.startedAt);
    const end = seconds(e.finishedAt);
    const known = byTask.get(e.taskId);
    byTask.set(e.taskId, {
      start: Math.min(known?.start ?? start, start),
      end: Math.max(known?.end ?? end, end),
    });
  }
  if (byTask.size < 2) return undefined;
  const spans = [...byTask.values()];
  const wall = Math.max(...spans.map((x) => x.end)) - Math.min(...spans.map((x) => x.start));
  const work = spans.reduce((total, x) => total + (x.end - x.start), 0);
  return wall > 0 ? { work, wall } : undefined;
}

type Interval = [start: number, end: number];

/** Merges overlapping intervals, so parallel work is counted once. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const merged: Interval[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const total = (intervals: Interval[]): number => intervals.reduce((n, [a, b]) => n + (b - a), 0);

/** The parts of `intervals` not already inside `covered` (both merged). */
function subtractIntervals(intervals: Interval[], covered: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const [start, end] of intervals) {
    let cursor = start;
    for (const [cs, ce] of covered) {
      if (ce <= cursor || cs >= end) continue;
      if (cs > cursor) result.push([cursor, cs]);
      cursor = Math.max(cursor, ce);
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

/** Verification spans of a run: each VERIFY_STARTED up to the next VERIFY_COMPLETED of the same task. */
function verificationIntervals(
  events: Array<{ type: string; taskId?: string; timestamp: Date }>,
): Interval[] {
  const open = new Map<string, number>();
  const spans: Interval[] = [];
  for (const e of events) {
    const key = e.taskId ?? '';
    if (e.type === 'VERIFY_STARTED') open.set(key, e.timestamp.getTime() / 1000);
    else if (e.type === 'VERIFY_COMPLETED' && open.has(key)) {
      spans.push([open.get(key)!, e.timestamp.getTime() / 1000]);
      open.delete(key);
    }
  }
  return spans;
}

interface RunTime {
  totalSeconds: number;
  agentSeconds: number;
  verificationSeconds: number;
  otherSeconds: number;
  beforeFirst: number;
  afterLast: number;
}

/** Time split of one finished run, or undefined when no real agent ran or the run has no end time. */
function runTime(
  run: { createdAt: string; completedAt?: string },
  executions: ExecutionRecord[],
  events: Array<{ type: string; taskId?: string; timestamp: Date }>,
): RunTime | undefined {
  if (!run.completedAt) return undefined;
  const real = executions.filter((e) => e.finishedAt && e.agentId !== 'fake-agent');
  if (real.length === 0) return undefined;

  const start = seconds(run.createdAt);
  const end = seconds(run.completedAt);
  const clip = (intervals: Interval[]): Interval[] =>
    intervals
      .map(([a, b]): Interval => [Math.max(a, start), Math.min(b, end)])
      .filter(([a, b]) => b > a);

  const agent = mergeIntervals(
    clip(real.map((e): Interval => [seconds(e.startedAt), seconds(e.finishedAt!)])),
  );
  const verification = subtractIntervals(
    mergeIntervals(clip(verificationIntervals(events))),
    agent,
  );
  if (agent.length === 0) return undefined;
  const wall = end - start;
  const agentSeconds = total(agent);
  const verificationSeconds = total(verification);
  return {
    totalSeconds: wall,
    agentSeconds,
    verificationSeconds,
    otherSeconds: Math.max(0, wall - agentSeconds - verificationSeconds),
    beforeFirst: Math.max(0, agent[0][0] - start),
    afterLast: Math.max(0, end - agent[agent.length - 1][1]),
  };
}

export function computeInsights(
  db: TaskForgeDatabase,
  options: { sinceDays?: number; now?: Date } = {},
): InsightsReport {
  const sinceDays = options.sinceDays ?? 30;
  const cutoff = (options.now ?? new Date()).getTime() - sinceDays * 86_400_000;
  const eventRepo = new EventRepository(db);
  const costRepo = new CostRepository(db);
  const executionRepo = new ExecutionRepository(db);

  const runs = new RunRepository(db)
    .listAll()
    .filter((r) => new Date(r.createdAt).getTime() >= cutoff);

  const byStatus: Record<string, number> = {};
  const causes = new Map<string, number>();
  let resumedRuns = 0;
  let undoneRuns = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let runsWithUsage = 0;
  const agents = new Map<string, AgentInsight & { totalSeconds: number; finished: number }>();
  const agentOf = (agentId: string) => {
    let entry = agents.get(agentId);
    if (!entry) {
      entry = {
        agentId,
        executions: 0,
        succeeded: 0,
        failed: 0,
        tokens: 0,
        totalSeconds: 0,
        finished: 0,
      };
      agents.set(agentId, entry);
    }
    return entry;
  };
  const timed: RunTime[] = [];
  let overlapWork = 0;
  let overlapWall = 0;
  let overlapRuns = 0;

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

    const executions = executionRepo.listByRun(run.id);
    for (const e of executions) {
      if (!e.finishedAt) continue;
      const entry = agentOf(e.agentId);
      entry.executions++;
      if (e.status === 'success') entry.succeeded++;
      else entry.failed++;
      entry.totalSeconds += seconds(e.finishedAt) - seconds(e.startedAt);
      entry.finished++;
    }
    for (const c of costRepo.listByRun(run.id)) agentOf(c.agentId).tokens += c.totalTokens ?? 0;
    const spent = runTime(run, executions, events);
    if (spent) timed.push(spent);
    const overlap = taskOverlap(executions);
    if (overlap) {
      overlapWork += overlap.work;
      overlapWall += overlap.wall;
      overlapRuns++;
    }

    const cost = costRepo.getTotalCostByRun(run.id);
    if (cost.totalTokens > 0) {
      runsWithUsage++;
      totalTokens += cost.totalTokens;
      totalCost += cost.totalCostUsd;
    }
  }

  const ended = ['completed', 'failed', 'cancelled', 'abandoned'].reduce(
    (n, s) => n + (byStatus[s] ?? 0),
    0,
  );
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
    agents: [...agents.values()]
      .sort((a, b) => b.executions - a.executions)
      .map(({ totalSeconds, finished, ...agent }) => ({
        ...agent,
        averageSeconds: finished > 0 ? Math.round(totalSeconds / finished) : undefined,
      })),
    time:
      timed.length > 0
        ? {
            runs: timed.length,
            totalSeconds: timed.reduce((n, t) => n + t.totalSeconds, 0),
            agentSeconds: timed.reduce((n, t) => n + t.agentSeconds, 0),
            verificationSeconds: timed.reduce((n, t) => n + t.verificationSeconds, 0),
            otherSeconds: timed.reduce((n, t) => n + t.otherSeconds, 0),
            averageSecondsBeforeFirstAgent:
              timed.reduce((n, t) => n + t.beforeFirst, 0) / timed.length,
            averageSecondsAfterLastAgent: timed.reduce((n, t) => n + t.afterLast, 0) / timed.length,
          }
        : undefined,
    parallelism:
      overlapRuns > 0
        ? { factor: Math.round((overlapWork / overlapWall) * 100) / 100, runs: overlapRuns }
        : undefined,
  };
}

export function formatInsights(report: InsightsReport): string[] {
  const n = (v: number) => v.toLocaleString('en-US');
  if (report.runs === 0) {
    return [`No runs in the last ${report.sinceDays} days.`];
  }
  const lines: string[] = [
    `Last ${report.sinceDays} days: ${report.runs} run${report.runs === 1 ? '' : 's'}`,
  ];
  const status = Object.entries(report.byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `${c} ${s}`)
    .join(', ');
  lines.push(`  Outcomes: ${status}`);
  if (report.completionRate !== undefined) {
    lines.push(
      `  Finished successfully: ${Math.round(report.completionRate * 100)}% of the runs that ended`,
    );
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
  if (report.parallelism) {
    lines.push(
      `  Parallel work: ${report.parallelism.factor.toFixed(2)}x across ${report.parallelism.runs} multi-task run${report.parallelism.runs === 1 ? '' : 's'} (1.00x = one task at a time)`,
    );
  }
  if (report.time && report.time.totalSeconds > 0) {
    const t = report.time;
    const share = (part: number) => `${Math.round((part / t.totalSeconds) * 100)}%`;
    lines.push(
      `  Where the time went (${t.runs} run${t.runs === 1 ? '' : 's'} with a real agent): agents working ${share(t.agentSeconds)}, checks ${share(t.verificationSeconds)}, TaskForge's own steps ${share(t.otherSeconds)}`,
    );
    lines.push(
      `    before the first agent starts: ${Math.round(t.averageSecondsBeforeFirstAgent)}s on average; after the last one finishes: ${Math.round(t.averageSecondsAfterLastAgent)}s (planning happens before the run and is not included)`,
    );
  }
  if (report.agents.length > 0) {
    lines.push('  By agent:');
    for (const a of report.agents) {
      const time = a.averageSeconds !== undefined ? `, ${a.averageSeconds}s on average` : '';
      lines.push(
        `    ${a.agentId}: ${a.succeeded}/${a.executions} succeeded${time}, ${n(a.tokens)} tokens`,
      );
    }
  }
  lines.push("  Computed from this project's local history only; nothing is sent anywhere.");
  return lines;
}
