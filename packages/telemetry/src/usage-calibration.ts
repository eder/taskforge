import type { TaskType } from '@taskforge/shared';
import { TaskForgeDatabase } from '@taskforge/persistence';
import type { UsageCalibration } from './types.js';

export interface UsageCalibrationQuery {
  taskType: TaskType;
  agentId?: string;
  role?: string;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 1;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clampRatio(value: number): number {
  return Math.max(0.25, Math.min(4, value));
}

export class UsageCalibrationEngine {
  constructor(private db: TaskForgeDatabase) {}

  getCalibration(query: UsageCalibrationQuery): UsageCalibration {
    const where = [
      "c.usage_source = 'provider_reported'",
      'c.total_tokens > 0',
      'c.planned_estimated_tokens > 0',
      't.type = ?',
    ];
    const params: unknown[] = [query.taskType];

    if (query.agentId) {
      where.push('c.agent_id = ?');
      params.push(query.agentId);
    }
    if (query.role) {
      where.push('c.role = ?');
      params.push(query.role);
    }

    const sql =
      'SELECT c.agent_id, c.input_tokens, c.cached_input_tokens, c.output_tokens, c.total_tokens, c.planned_estimated_tokens ' +
      'FROM cost_tracking c ' +
      'JOIN tasks t ON t.id = c.task_id ' +
      'WHERE ' +
      where.join(' AND ') +
      ' ORDER BY c.created_at ASC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      agent_id: string;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      planned_estimated_tokens: number;
    }>;

    const ratios = rows
      .map((row) => {
        // Calibrate the planning baseline against fresh provider work, not the
        // full cached context footprint. New records normalize cached input as
        // a subset of input. Legacy Claude rows stored cache categories
        // separately, which can be detected because total == input+cache+output.
        const legacyClaudeAdditiveCache =
          row.agent_id === 'claude' &&
          row.cached_input_tokens > 0 &&
          row.total_tokens ===
            row.input_tokens + row.cached_input_tokens + row.output_tokens;
        const uncachedInput = legacyClaudeAdditiveCache
          ? row.input_tokens
          : Math.max(0, row.input_tokens - row.cached_input_tokens);
        const freshWorkTokens = uncachedInput + row.output_tokens;
        return freshWorkTokens / row.planned_estimated_tokens;
      })
      .filter((ratio) => Number.isFinite(ratio) && ratio > 0)
      .sort((a, b) => a - b);

    const sampleSize = ratios.length;
    const confidence: UsageCalibration['confidence'] =
      sampleSize >= 10 ? 'high' : sampleSize >= 3 ? 'medium' : 'low';

    return {
      taskType: query.taskType,
      agentId: query.agentId,
      role: query.role,
      sampleSize,
      p25Ratio: clampRatio(quantile(ratios, 0.25)),
      medianRatio: clampRatio(quantile(ratios, 0.5)),
      p75Ratio: clampRatio(quantile(ratios, 0.75)),
      confidence,
    };
  }

  getTaskTypeCalibrations(taskTypes: TaskType[]): Partial<Record<TaskType, UsageCalibration>> {
    const result: Partial<Record<TaskType, UsageCalibration>> = {};
    for (const taskType of new Set(taskTypes)) {
      const calibration = this.getCalibration({ taskType });
      if (calibration.sampleSize > 0) {
        result[taskType] = calibration;
      }
    }
    return result;
  }
}
