import {
  VerificationResult,
} from '@taskforge/shared';
import { TaskForgeDatabase } from '../database.js';

export class VerificationRepository {
  constructor(private db: TaskForgeDatabase) {}

  save(taskId: string, runId: string, result: VerificationResult): void {
    const id = `ver-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          'INSERT INTO verification_results (id, run_id, task_id, passed, checks_json, failure_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          runId,
          taskId,
          result.passed ? 1 : 0,
          JSON.stringify(result.checks),
          result.failureReason ?? null,
          now,
        );
    } catch {
      // Fallback for legacy databases where task_id might fail foreign key check
      try {
        this.db
          .prepare(
            'INSERT INTO verification_results (id, run_id, task_id, passed, checks_json, failure_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            runId,
            null,
            result.passed ? 1 : 0,
            JSON.stringify(result.checks),
            result.failureReason ?? null,
            now,
          );
      } catch {
        // Silently skip if DB rejects null on legacy table
      }
    }
  }

  getLatestByTask(taskId: string): VerificationResult | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM verification_results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(taskId) as
      | {
          passed: number;
          checks_json: string;
          failure_reason: string | null;
        }
      | undefined;

    if (!row) return undefined;
    return {
      passed: row.passed === 1,
      checks: JSON.parse(row.checks_json),
      failureReason: row.failure_reason ?? undefined,
    };
  }

  /** Latest verification result per task for a run (tasks verified several times keep only the last). */
  listLatestByRun(runId: string): Array<{ taskId?: string; result: VerificationResult }> {
    const rows = this.db
      .prepare('SELECT * FROM verification_results WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Array<{
      task_id: string | null;
      passed: number;
      checks_json: string;
      failure_reason: string | null;
    }>;
    const latest = new Map<string, { taskId?: string; result: VerificationResult }>();
    rows.forEach((row, index) => {
      latest.set(row.task_id ?? `__run_${index}`, {
        taskId: row.task_id ?? undefined,
        result: {
          passed: row.passed === 1,
          checks: JSON.parse(row.checks_json ?? '[]'),
          failureReason: row.failure_reason ?? undefined,
        },
      });
    });
    return [...latest.values()];
  }
}
