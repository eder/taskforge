import { TaskForgeDatabase } from '../database.js';

export interface RunMetricsRecord {
  id: string;
  runId: string;
  totalDurationMs: number;
  totalCostUsd: number;
  tasksCount: number;
  tasksCompleted: number;
  tasksFailed: number;
  reworkCount: number;
  escalationsCount: number;
  firstPassRate: number;
  createdAt: string;
}

export class RunMetricsRepository {
  constructor(private db: TaskForgeDatabase) {}

  save(record: {
    id: string;
    runId: string;
    totalDurationMs: number;
    totalCostUsd: number;
    tasksCount: number;
    tasksCompleted: number;
    tasksFailed: number;
    reworkCount: number;
    escalationsCount: number;
    firstPassRate: number;
  }): RunMetricsRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO run_metrics (
          id, run_id, total_duration_ms, total_cost_usd,
          tasks_count, tasks_completed, tasks_failed,
          rework_count, escalations_count, first_pass_rate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.totalDurationMs,
        record.totalCostUsd,
        record.tasksCount,
        record.tasksCompleted,
        record.tasksFailed,
        record.reworkCount,
        record.escalationsCount,
        record.firstPassRate,
        now,
      );

    return {
      ...record,
      createdAt: now,
    };
  }

  getByRun(runId: string): RunMetricsRecord | undefined {
    const r = this.db.prepare('SELECT * FROM run_metrics WHERE run_id = ?').get(runId) as
      | {
          id: string;
          run_id: string;
          total_duration_ms: number;
          total_cost_usd: number;
          tasks_count: number;
          tasks_completed: number;
          tasks_failed: number;
          rework_count: number;
          escalations_count: number;
          first_pass_rate: number;
          created_at: string;
        }
      | undefined;

    if (!r) return undefined;
    return {
      id: r.id,
      runId: r.run_id,
      totalDurationMs: r.total_duration_ms,
      totalCostUsd: r.total_cost_usd,
      tasksCount: r.tasks_count,
      tasksCompleted: r.tasks_completed,
      tasksFailed: r.tasks_failed,
      reworkCount: r.rework_count,
      escalationsCount: r.escalations_count,
      firstPassRate: r.first_pass_rate,
      createdAt: r.created_at,
    };
  }

  listAll(): RunMetricsRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM run_metrics ORDER BY created_at DESC')
      .all() as Array<{
      id: string;
      run_id: string;
      total_duration_ms: number;
      total_cost_usd: number;
      tasks_count: number;
      tasks_completed: number;
      tasks_failed: number;
      rework_count: number;
      escalations_count: number;
      first_pass_rate: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      totalDurationMs: r.total_duration_ms,
      totalCostUsd: r.total_cost_usd,
      tasksCount: r.tasks_count,
      tasksCompleted: r.tasks_completed,
      tasksFailed: r.tasks_failed,
      reworkCount: r.rework_count,
      escalationsCount: r.escalations_count,
      firstPassRate: r.first_pass_rate,
      createdAt: r.created_at,
    }));
  }
}
