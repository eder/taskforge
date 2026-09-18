import { TaskForgeDatabase } from '@taskforge/persistence';
import { AgentPerformanceStats, PerformanceDimensions } from './types.js';

export interface PerformanceEngineOptions {
  minSampleSize?: number;
}

export class PerformanceEngine {
  private minSampleSize: number;

  constructor(
    private db: TaskForgeDatabase,
    options: PerformanceEngineOptions = {},
  ) {
    this.minSampleSize = options.minSampleSize ?? 3;
  }

  getAgentStats(dimensions: PerformanceDimensions): AgentPerformanceStats {
    // Query historical executions and assignments for this agent + role + taskType
    const rows = this.db
      .prepare(
        `SELECT
          e.status,
          e.exit_code,
          (strftime('%s', e.finished_at) - strftime('%s', e.started_at)) * 1000 as duration_ms,
          t.rework_count,
          COALESCE(c.estimated_cost_usd, 0.0) as cost_usd
        FROM executions e
        JOIN assignments a ON e.assignment_id = a.id
        JOIN tasks t ON e.task_id = t.id
        LEFT JOIN cost_tracking c ON e.task_id = c.task_id AND e.agent_id = c.agent_id
        WHERE e.agent_id = ?
          AND a.role = ?
          AND t.type = ?`,
      )
      .all(dimensions.agentId, dimensions.role, dimensions.taskType) as Array<{
      status: string;
      exit_code: number | null;
      duration_ms: number | null;
      rework_count: number;
      cost_usd: number;
    }>;

    const sampleSize = rows.length;

    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (sampleSize >= 5) {
      confidence = 'high';
    } else if (sampleSize >= this.minSampleSize) {
      confidence = 'medium';
    }

    if (sampleSize === 0) {
      return {
        agentId: dimensions.agentId,
        role: dimensions.role,
        taskType: dimensions.taskType,
        sampleSize: 0,
        confidence: 'low',
        successRate: 0.5, // neutral baseline when no data
        firstPassRate: 0.5,
        averageDurationMs: 0,
        costPerSuccessfulTask: 0,
        reworkRate: 0,
        escalationRate: 0,
        qualityScore: 0.5,
        compositeScore: 0.5,
      };
    }

    const successes = rows.filter((r) => r.status === 'success' || r.exit_code === 0).length;
    const successRate = Number((successes / sampleSize).toFixed(3));

    const firstPassCount = rows.filter((r) => r.rework_count === 0 && (r.status === 'success' || r.exit_code === 0)).length;
    const firstPassRate = Number((firstPassCount / sampleSize).toFixed(3));

    const totalDuration = rows.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0);
    const averageDurationMs = Math.round(totalDuration / sampleSize);

    const totalCost = rows.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0);
    const costPerSuccessfulTask = Number((totalCost / Math.max(1, successes)).toFixed(4));

    const totalRework = rows.reduce((acc, r) => acc + (r.rework_count ?? 0), 0);
    const reworkRate = Number((totalRework / sampleSize).toFixed(3));

    // Check escalations in event log
    const escalationCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM events
           WHERE type = 'COLLABORATION_ESCALATED'
             AND json_extract(payload_json, '$.workerAgentId') = ?`,
        )
        .get(dimensions.agentId) as { cnt: number } | undefined
    )?.cnt ?? 0;

    const escalationRate = Number((escalationCount / sampleSize).toFixed(3));

    // Quality score based on first pass rate and low rework
    const qualityScore = Math.max(0, Math.min(1, firstPassRate - (reworkRate * 0.1)));

    // Composite score formula from Section 26.2:
    // score ≈ success_probability × quality_score - cost_penalty - latency_penalty - rework_penalty - coordination_penalty
    const costPenalty = Math.min(0.2, costPerSuccessfulTask * 0.1);
    const latencyPenalty = Math.min(0.2, (averageDurationMs / 60000) * 0.05);
    const reworkPenalty = Math.min(0.2, reworkRate * 0.1);
    const coordinationPenalty = Math.min(0.1, escalationRate * 0.05);

    const rawScore = (successRate * qualityScore) - costPenalty - latencyPenalty - reworkPenalty - coordinationPenalty;
    const compositeScore = Number(Math.max(0, Math.min(1, rawScore)).toFixed(3));

    return {
      agentId: dimensions.agentId,
      role: dimensions.role,
      taskType: dimensions.taskType,
      sampleSize,
      confidence,
      successRate,
      firstPassRate,
      averageDurationMs,
      costPerSuccessfulTask,
      reworkRate,
      escalationRate,
      qualityScore,
      compositeScore,
    };
  }

  formatAgentReport(stats: AgentPerformanceStats): string {
    const lines = [
      `Performance Profile: ${stats.agentId} [Role: ${stats.role}, Type: ${stats.taskType}]`,
      `  Sample Size: ${stats.sampleSize} (${stats.confidence.toUpperCase()} confidence)`,
      `  Success Rate: ${(stats.successRate * 100).toFixed(1)}%`,
      `  First-pass Pass Rate: ${(stats.firstPassRate * 100).toFixed(1)}%`,
      `  Avg Duration: ${(stats.averageDurationMs / 1000).toFixed(1)}s`,
      `  Cost per Success: $${stats.costPerSuccessfulTask.toFixed(4)}`,
      `  Rework Rate: ${stats.reworkRate.toFixed(2)} cycles/task`,
      `  Composite Routing Score: ${stats.compositeScore.toFixed(3)}`,
    ];
    return lines.join('\n');
  }
}
