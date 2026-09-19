import { randomUUID } from 'node:crypto';
import { TaskForgeDatabase, CostRepository, RunMetricsRepository } from '@taskforge/persistence';
import { CostEstimator } from './cost-estimator.js';
import { RunCostReport, RunSummaryStats, TaskCostSummary } from './types.js';

export class TelemetryCollector {
  private costRepo: CostRepository;
  private metricsRepo: RunMetricsRepository;

  constructor(private db: TaskForgeDatabase) {
    this.costRepo = new CostRepository(this.db);
    this.metricsRepo = new RunMetricsRepository(this.db);
  }

  recordTaskTokens(item: {
    runId: string;
    taskId: string;
    agentId: string;
    modelName: string;
    inputTokens: number;
    outputTokens: number;
  }): TaskCostSummary {
    const costUsd = CostEstimator.estimateCost(item.modelName, item.inputTokens, item.outputTokens);

    this.costRepo.record({
      id: `cost-${randomUUID()}`,
      runId: item.runId,
      taskId: item.taskId,
      agentId: item.agentId,
      modelName: item.modelName,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      estimatedCostUsd: costUsd,
    });

    return {
      taskId: item.taskId,
      agentId: item.agentId,
      modelName: item.modelName,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
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
      agentId: r.agentId,
      modelName: r.modelName,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.estimatedCostUsd,
    }));

    return {
      runId,
      totalCostUsd: totals.totalCostUsd,
      totalInputTokens: totals.totalInputTokens,
      totalOutputTokens: totals.totalOutputTokens,
      breakdown,
    };
  }

  getRunSummary(runId: string): RunSummaryStats | undefined {
    const m = this.metricsRepo.getByRun(runId);
    if (!m) return undefined;
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
    };
  }

  formatCostReport(runId: string): string {
    const report = this.getCostReport(runId);
    if (report.breakdown.length === 0) {
      return `Nenhum custo registrado para o run ${runId}. (Tokens: 0, Custo: $0.000)`;
    }

    const lines = [
      `Relatório de Custos - Run ${runId}`,
      `Total estimado: $${report.totalCostUsd.toFixed(4)} USD`,
      `Tokens: ${report.totalInputTokens.toLocaleString()} in / ${report.totalOutputTokens.toLocaleString()} out`,
      'Detalhamento por tarefa:',
      ...report.breakdown.map(
        (b) =>
          `  - ${b.taskId} [${b.agentId} (${b.modelName})]: $${b.costUsd.toFixed(4)} (${b.inputTokens.toLocaleString()} in / ${b.outputTokens.toLocaleString()} out)`,
      ),
    ];
    return lines.join('\n');
  }

  formatStatsReport(runId: string): string {
    const summary = this.getRunSummary(runId);
    if (!summary) {
      return `Nenhuma métrica registrada para o run ${runId}.`;
    }

    const durationSec = (summary.durationMs / 1000).toFixed(1);
    const passPct = (summary.firstPassRate * 100).toFixed(1);

    const lines = [
      `Métricas do Run ${runId}`,
      `  Duração: ${durationSec}s`,
      `  Tarefas: ${summary.tasksCompleted}/${summary.tasksCount} concluídas (${summary.tasksFailed} falhas)`,
      `  Taxa de aprovação de primeira passagem: ${passPct}%`,
      `  Ciclos de retrabalho: ${summary.reworkCount}`,
      `  Escalações de colaboração: ${summary.escalationsCount}`,
      `  Custo total: $${summary.totalCostUsd.toFixed(4)} USD`,
    ];
    return lines.join('\n');
  }
}
