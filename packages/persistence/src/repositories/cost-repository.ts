import { TaskForgeDatabase } from '../database.js';

export interface CostRecord {
  id: string;
  runId: string;
  taskId: string;
  assignmentId?: string;
  agentId: string;
  role?: string;
  modelName: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageSource: string;
  plannedEstimatedTokens: number;
  estimatedCostUsd: number;
  createdAt: string;
}

export class CostRepository {
  constructor(private db: TaskForgeDatabase) {}

  record(item: {
    id: string;
    runId: string;
    taskId: string;
    assignmentId?: string;
    agentId: string;
    role?: string;
    modelName: string;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    usageSource?: string;
    plannedEstimatedTokens?: number;
    estimatedCostUsd?: number;
  }): CostRecord {
    const now = new Date().toISOString();
    const inputTokens = item.inputTokens ?? 0;
    const cachedInputTokens = item.cachedInputTokens ?? 0;
    const outputTokens = item.outputTokens ?? 0;
    const totalTokens = item.totalTokens ?? inputTokens + outputTokens;
    const usageSource = item.usageSource ?? 'provider_reported';
    const plannedEstimatedTokens = item.plannedEstimatedTokens ?? 0;
    const estimatedCostUsd = item.estimatedCostUsd ?? 0.0;

    this.db
      .prepare(
        `INSERT INTO cost_tracking (
          id, run_id, task_id, assignment_id, agent_id, role, model_name,
          input_tokens, cached_input_tokens, output_tokens, total_tokens,
          usage_source, planned_estimated_tokens, estimated_cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.runId,
        item.taskId,
        item.assignmentId ?? null,
        item.agentId,
        item.role ?? null,
        item.modelName,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        usageSource,
        plannedEstimatedTokens,
        estimatedCostUsd,
        now,
      );

    return {
      id: item.id,
      runId: item.runId,
      taskId: item.taskId,
      assignmentId: item.assignmentId,
      agentId: item.agentId,
      role: item.role,
      modelName: item.modelName,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      usageSource,
      plannedEstimatedTokens,
      estimatedCostUsd,
      createdAt: now,
    };
  }

  listByRun(runId: string): CostRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM cost_tracking WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Array<{
      id: string;
      run_id: string;
      task_id: string;
      assignment_id: string | null;
      agent_id: string;
      role: string | null;
      model_name: string;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      usage_source: string;
      planned_estimated_tokens: number;
      estimated_cost_usd: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      taskId: r.task_id,
      assignmentId: r.assignment_id ?? undefined,
      agentId: r.agent_id,
      role: r.role ?? undefined,
      modelName: r.model_name,
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_input_tokens ?? 0,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens || r.input_tokens + r.output_tokens,
      usageSource: r.usage_source ?? 'provider_reported',
      plannedEstimatedTokens: r.planned_estimated_tokens ?? 0,
      estimatedCostUsd: r.estimated_cost_usd,
      createdAt: r.created_at,
    }));
  }

  getTotalCostByRun(runId: string): {
    totalCostUsd: number;
    totalInputTokens: number;
    totalCachedInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalPlannedEstimatedTokens: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(estimated_cost_usd), 0.0) as total_cost,
          COALESCE(SUM(input_tokens), 0) as total_input,
          COALESCE(SUM(cached_input_tokens), 0) as total_cached_input,
          COALESCE(SUM(output_tokens), 0) as total_output,
          COALESCE(SUM(CASE WHEN total_tokens > 0 THEN total_tokens ELSE input_tokens + output_tokens END), 0) as total_tokens,
          COALESCE(SUM(planned_estimated_tokens), 0) as total_planned
        FROM cost_tracking WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          total_cost: number;
          total_input: number;
          total_cached_input: number;
          total_output: number;
          total_tokens: number;
          total_planned: number;
        }
      | undefined;

    return {
      totalCostUsd: row?.total_cost ?? 0.0,
      totalInputTokens: row?.total_input ?? 0,
      totalCachedInputTokens: row?.total_cached_input ?? 0,
      totalOutputTokens: row?.total_output ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      totalPlannedEstimatedTokens: row?.total_planned ?? 0,
    };
  }
}
