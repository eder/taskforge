import { randomUUID } from 'node:crypto';
import { TaskForgeDatabase, CostRepository, RunMetricsRepository } from '@taskforge/persistence';
import { CostEstimator } from './cost-estimator.js';
import {
  RunCostReport,
  RunSummaryStats,
  TaskCostSummary,
  StaffingBottlenecks,
  UsageAccuracyReport,
  OrchestrationEfficiencyReport,
} from './types.js';
import { OrchestrationEfficiencyAnalyzer } from './orchestration-efficiency.js';

export class TelemetryCollector {
  private costRepo: CostRepository;
  private metricsRepo: RunMetricsRepository;
  private efficiencyAnalyzer: OrchestrationEfficiencyAnalyzer;

  constructor(private db: TaskForgeDatabase) {
    this.costRepo = new CostRepository(this.db);
    this.metricsRepo = new RunMetricsRepository(this.db);
    this.efficiencyAnalyzer = new OrchestrationEfficiencyAnalyzer(this.db);
  }

  recordTaskTokens(item: {
    runId: string;
    taskId: string;
    assignmentId?: string;
    agentId: string;
    role?: string;
    modelName: string;
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    totalTokens?: number;
    usageSource?: string;
    plannedEstimatedTokens?: number;
  }): TaskCostSummary {
    const cachedInputTokens = item.cachedInputTokens ?? 0;
    const totalTokens =
      item.totalTokens ?? item.inputTokens + cachedInputTokens + item.outputTokens;
    // Cached input pricing differs by provider/model and is not normalized yet.
    // Treat it as ordinary input for the existing *estimated* cost model while
    // preserving the cached count separately for usage accuracy/calibration.
    const costUsd = CostEstimator.estimateCost(
      item.modelName,
      item.inputTokens + cachedInputTokens,
      item.outputTokens,
    );

    this.costRepo.record({
      id: `cost-${randomUUID()}`,
      runId: item.runId,
      taskId: item.taskId,
      assignmentId: item.assignmentId,
      agentId: item.agentId,
      role: item.role,
      modelName: item.modelName,
      inputTokens: item.inputTokens,
      cachedInputTokens,
      outputTokens: item.outputTokens,
      totalTokens,
      usageSource: item.usageSource ?? 'provider_reported',
      plannedEstimatedTokens: item.plannedEstimatedTokens ?? 0,
      estimatedCostUsd: costUsd,
    });

    return {
      taskId: item.taskId,
      assignmentId: item.assignmentId,
      agentId: item.agentId,
      role: item.role,
      modelName: item.modelName,
      inputTokens: item.inputTokens,
      cachedInputTokens,
      outputTokens: item.outputTokens,
      totalTokens,
      usageSource: item.usageSource ?? 'provider_reported',
      plannedEstimatedTokens: item.plannedEstimatedTokens ?? 0,
      costUsd,
    };
  }

  recordRunMetrics(metrics: {
    runId: string;
    durationMs: number;
    totalCostUsd?: number;
    tasksCount: number;
    tasksCompleted: number;
    tasksFailed: number;
    reworkCount: number;
    escalationsCount: number;
  }): RunSummaryStats {
    const costTotals = this.costRepo.getTotalCostByRun(metrics.runId);
    const totalCostUsd = metrics.totalCostUsd ?? costTotals.totalCostUsd;

    const firstPassCount = Math.max(0, metrics.tasksCompleted - metrics.reworkCount);
    const firstPassRate =
      metrics.tasksCount > 0 ? Number((firstPassCount / metrics.tasksCount).toFixed(3)) : 1.0;

    this.metricsRepo.save({
      id: `rm-${randomUUID()}`,
      runId: metrics.runId,
      totalDurationMs: metrics.durationMs,
      totalCostUsd,
      tasksCount: metrics.tasksCount,
      tasksCompleted: metrics.tasksCompleted,
      tasksFailed: metrics.tasksFailed,
      reworkCount: metrics.reworkCount,
      escalationsCount: metrics.escalationsCount,
      firstPassRate,
    });

    return {
      runId: metrics.runId,
      durationMs: metrics.durationMs,
      totalCostUsd,
      tasksCount: metrics.tasksCount,
      tasksCompleted: metrics.tasksCompleted,
      tasksFailed: metrics.tasksFailed,
      reworkCount: metrics.reworkCount,
      escalationsCount: metrics.escalationsCount,
      firstPassRate,
    };
  }

  getCostReport(runId: string): RunCostReport {
    const records = this.costRepo.listByRun(runId);
    const totals = this.costRepo.getTotalCostByRun(runId);

    const breakdown: TaskCostSummary[] = records.map((r) => ({
      taskId: r.taskId,
      assignmentId: r.assignmentId,
      agentId: r.agentId,
      role: r.role,
      modelName: r.modelName,
      inputTokens: r.inputTokens,
      cachedInputTokens: r.cachedInputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.totalTokens,
      usageSource: r.usageSource,
      plannedEstimatedTokens: r.plannedEstimatedTokens,
      costUsd: r.estimatedCostUsd,
    }));

    return {
      runId,
      totalCostUsd: totals.totalCostUsd,
      totalInputTokens: totals.totalInputTokens,
      totalCachedInputTokens: totals.totalCachedInputTokens,
      totalOutputTokens: totals.totalOutputTokens,
      totalTokens: totals.totalTokens,
      totalPlannedEstimatedTokens: totals.totalPlannedEstimatedTokens,
      breakdown,
    };
  }

  getUsageAccuracy(runId: string): UsageAccuracyReport {
    const report = this.getCostReport(runId);
    const observed = report.breakdown.filter(
      (item) => item.usageSource === 'provider_reported' && item.totalTokens > 0,
    );
    const observedTokens = observed.reduce((sum, item) => sum + item.totalTokens, 0);
    const plannedEstimatedTokens = observed.reduce(
      (sum, item) => sum + item.plannedEstimatedTokens,
      0,
    );

    return {
      runId,
      observedTokens,
      plannedEstimatedTokens,
      varianceRatio:
        plannedEstimatedTokens > 0 ? observedTokens / plannedEstimatedTokens : undefined,
      observedAssignments: observed.length,
    };
  }

  getStaffingMetrics(runId: string): StaffingBottlenecks {
    try {
      const rows = this.db
        .prepare(
          `SELECT type, count(*) as count FROM events WHERE run_id = ? AND type IN ('STAFFING_CAPPED', 'COLLABORATION_REJECTED', 'COLLABORATION_APPROVED', 'COLLABORATION_DELAYED') GROUP BY type`,
        )
        .all(runId) as Array<{ type: string; count: number }>;

      let staffingCappedCount = 0;
      let collaborationRejectedCount = 0;
      let collaborationApprovedCount = 0;
      let collaborationDelayedCount = 0;

      for (const row of rows) {
        if (row.type === 'STAFFING_CAPPED') staffingCappedCount = row.count;
        else if (row.type === 'COLLABORATION_REJECTED') collaborationRejectedCount = row.count;
        else if (row.type === 'COLLABORATION_APPROVED') collaborationApprovedCount = row.count;
        else if (row.type === 'COLLABORATION_DELAYED') collaborationDelayedCount = row.count;
      }

      return {
        staffingCappedCount,
        collaborationRejectedCount,
        collaborationApprovedCount,
        collaborationDelayedCount,
      };
    } catch {
      return {
        staffingCappedCount: 0,
        collaborationRejectedCount: 0,
        collaborationApprovedCount: 0,
        collaborationDelayedCount: 0,
      };
    }
  }

  getOrchestrationEfficiency(runId: string): OrchestrationEfficiencyReport {
    return this.efficiencyAnalyzer.analyze(runId);
  }

  formatOrchestrationEfficiencyReport(runId: string): string {
    const report = this.getOrchestrationEfficiency(runId);
    const outcomeLabel: Record<OrchestrationEfficiencyReport['outcome'], string> = {
      right_sized: 'RIGHT-SIZED',
      fan_out_justified: 'FAN-OUT JUSTIFIED',
      fan_out_not_justified: 'INEFFICIENT',
      inconclusive: 'INCONCLUSIVE',
    };
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
    const ms = (value: number) => `${(value / 1000).toFixed(1)}s`;
    const tokens = (value: number) => value.toLocaleString();

    const lines = [
      `Orchestration Efficiency - Run ${runId}`,
      `  Outcome: ${outcomeLabel[report.outcome]}`,
      `  Shape: ${report.taskCount} task(s), ${report.assignmentCount} assignment(s), ${report.uniqueAgents} agent(s)`,
      `  Assignment yield: ${report.usefulAssignments} useful / ${report.wastedAssignments} wasted (${pct(report.wastedAssignmentRatio)} waste)`,
      `  Recovery overhead: ${report.retryOrFailoverAssignments} retry/failover assignment(s)`,
      `  Time: ${ms(report.activeExecutionMs)} active, ${ms(report.serialExecutionMs)} serial work, ${ms(report.observedParallelOverlapMs)} observed overlap (${report.parallelismFactor.toFixed(2)}× parallelism)`,
      report.providerReportedTokens > 0
        ? `  Tokens: ${tokens(report.providerReportedTokens)} provider-reported, ${tokens(report.wastedProviderTokens)} wasted${report.wastedTokenRatio !== undefined ? ` (${pct(report.wastedTokenRatio)})` : ''}`
        : '  Tokens: provider-reported usage unavailable',
      report.tokenVarianceRatio !== undefined
        ? `  Token baseline variance: ${report.tokenVarianceRatio.toFixed(1)}×`
        : undefined,
      `  Quality: ${pct(report.firstPassRate)} first-pass, ${report.reworkCount} rework, ${report.completionGateRejections} completion rejection(s), ${report.specializedQualityAssignments} specialist quality assignment(s)`,
      `  Signals: time=${report.timeBenefitObserved ? 'observed' : 'not observed'}, quality=${report.qualityGuardSignalObserved ? 'observed' : 'not observed'}, token-waste=${report.tokenWasteAcceptable ? 'acceptable' : 'high'}`,
      ...report.reasons.map((reason) => `  - ${reason}`),
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  }

  getRunSummary(runId: string): RunSummaryStats | undefined {
    const m = this.metricsRepo.getByRun(runId);
    if (!m) return undefined;
    const staffingBottlenecks = this.getStaffingMetrics(runId);
    return {
      runId: m.runId,
      durationMs: m.totalDurationMs,
      totalCostUsd: m.totalCostUsd,
      tasksCount: m.tasksCount,
      tasksCompleted: m.tasksCompleted,
      tasksFailed: m.tasksFailed,
      reworkCount: m.reworkCount,
      escalationsCount: m.escalationsCount,
      firstPassRate: m.firstPassRate,
      staffingBottlenecks,
    };
  }

  formatCostReport(runId: string): string {
    const report = this.getCostReport(runId);
    if (report.breakdown.length === 0) {
      return `No costs recorded for run ${runId}. (Tokens: 0, Cost: $0.000)`;
    }

    const accuracy = this.getUsageAccuracy(runId);
    const comparison =
      accuracy.observedAssignments > 0 && accuracy.plannedEstimatedTokens > 0
        ? `Observed vs assignment baseline: ${accuracy.observedTokens.toLocaleString()} / ${accuracy.plannedEstimatedTokens.toLocaleString()} tokens (${((accuracy.varianceRatio ?? 1) * 100).toFixed(0)}%)`
        : undefined;

    const lines = [
      `Cost Report - Run ${runId}`,
      `Total estimated: $${report.totalCostUsd.toFixed(4)} USD`,
      `Observed tokens: ${report.totalTokens.toLocaleString()} total (${report.totalInputTokens.toLocaleString()} input / ${report.totalCachedInputTokens.toLocaleString()} cached / ${report.totalOutputTokens.toLocaleString()} output)`,
      comparison,
      'Task breakdown:',
      ...report.breakdown.map(
        (b) =>
          `  - ${b.taskId} [${b.agentId} (${b.modelName})]: $${b.costUsd.toFixed(4)} (${b.totalTokens.toLocaleString()} observed; source=${b.usageSource}${b.plannedEstimatedTokens > 0 ? `; baseline=${b.plannedEstimatedTokens.toLocaleString()}` : ''})`,
      ),
    ].filter((line): line is string => Boolean(line));
    return lines.join('\n');
  }

  formatStatsReport(runId: string): string {
    const summary = this.getRunSummary(runId);
    if (!summary) {
      return `No metrics recorded for run ${runId}.`;
    }

    const durationSec = (summary.durationMs / 1000).toFixed(1);
    const passPct = (summary.firstPassRate * 100).toFixed(1);

    const lines = [
      `Run Metrics - ${runId}`,
      `  Duration: ${durationSec}s`,
      `  Tasks: ${summary.tasksCompleted}/${summary.tasksCount} completed (${summary.tasksFailed} failed)`,
      `  First-pass verification rate: ${passPct}%`,
      `  Rework cycles: ${summary.reworkCount}`,
      `  Collaboration escalations: ${summary.escalationsCount}`,
      `  Total cost: $${summary.totalCostUsd.toFixed(4)} USD`,
    ];

    if (summary.staffingBottlenecks) {
      const {
        staffingCappedCount,
        collaborationRejectedCount,
        collaborationApprovedCount,
        collaborationDelayedCount,
      } = summary.staffingBottlenecks;

      if (staffingCappedCount > 0 || collaborationRejectedCount > 0) {
        lines.push(
          `  Staffing bottlenecks: ${staffingCappedCount} capped, ${collaborationRejectedCount} rejected (maxAgentsPerTask limit hit)`,
        );
      }
      if (collaborationDelayedCount > 0) {
        lines.push(
          `  Concurrency delays: ${collaborationDelayedCount} delayed (waiting for concurrency slots)`,
        );
      }
      if (collaborationApprovedCount > 0) {
        lines.push(
          `  Collaboration approved: ${collaborationApprovedCount} emergent helper assignment(s)`,
        );
      }
    }

    lines.push('', this.formatOrchestrationEfficiencyReport(runId));
    return lines.join('\n');
  }
}
