import {
  TaskStatus,
  TaskType,
  TaskContract,
} from '@taskforge/shared';
import { TaskForgeDatabase } from '../database.js';

export interface TaskRecord {
  id: string;
  runId: string;
  goalId?: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  contractJson?: string;
  executionStrategyJson?: string;
  acceptanceCriteriaJson?: string;
  reworkCount: number;
  createdAt: string;
  updatedAt: string;
  dependencies?: string[];
}

export class TaskRepository {
  constructor(private db: TaskForgeDatabase) {}

  create(task: {
    id: string;
    runId: string;
    goalId?: string;
    title: string;
    description: string;
    type: TaskType;
    status: TaskStatus;
    contract?: TaskContract;
    executionStrategy?: unknown;
    acceptanceCriteria?: string[];
    dependencies?: string[];
  }): TaskRecord {
    const now = new Date().toISOString();
    const contractJson = task.contract ? JSON.stringify(task.contract) : null;
    const executionStrategyJson = task.executionStrategy
      ? JSON.stringify(task.executionStrategy)
      : null;
    const acceptanceCriteriaJson = task.acceptanceCriteria
      ? JSON.stringify(task.acceptanceCriteria)
      : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (
          id, run_id, goal_id, title, description, type, status,
          contract_json, execution_strategy_json, acceptance_criteria_json,
          rework_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        task.id,
        task.runId,
        task.goalId ?? null,
        task.title,
        task.description,
        task.type,
        task.status,
        contractJson,
        executionStrategyJson,
        acceptanceCriteriaJson,
        now,
        now,
      );

    if (task.contract) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO task_contracts (
            task_id, objective, allowed_scope_json, forbidden_changes_json,
            acceptance_criteria_json, dependencies_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.contract.objective,
          JSON.stringify(task.contract.allowedScope ?? []),
          JSON.stringify(task.contract.forbiddenChanges ?? []),
          JSON.stringify(task.contract.acceptanceCriteria ?? []),
          JSON.stringify(task.contract.dependencies ?? []),
        );
    }

    if (task.dependencies && task.dependencies.length > 0) {
      const depStmt = this.db.prepare(
        'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
      );
      for (const dep of task.dependencies) {
        depStmt.run(task.id, dep);
      }
    }

    return {
      id: task.id,
      runId: task.runId,
      goalId: task.goalId,
      title: task.title,
      description: task.description,
      type: task.type,
      status: task.status,
      contractJson: contractJson ?? undefined,
      executionStrategyJson: executionStrategyJson ?? undefined,
      acceptanceCriteriaJson: acceptanceCriteriaJson ?? undefined,
      reworkCount: 0,
      createdAt: now,
      updatedAt: now,
      dependencies: task.dependencies ?? [],
    };
  }

  updateStatus(taskId: string, status: TaskStatus): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, taskId);
  }

  /** Whether any run (past or present) already owns a task with this id. */
  idExists(taskId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS x FROM tasks WHERE id = ?').get(taskId));
  }

  /** Highest N among persisted task ids shaped like TASK-N (0 when none). */
  maxNumericTaskId(): number {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE id LIKE 'TASK-%'").all() as Array<{
      id: string;
    }>;
    let max = 0;
    for (const { id } of rows) {
      const match = /^TASK-(\d+)$/.exec(id);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return max;
  }

  incrementRework(taskId: string): number {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE tasks SET rework_count = rework_count + 1, updated_at = ? WHERE id = ?')
      .run(now, taskId);
    const row = this.db.prepare('SELECT rework_count FROM tasks WHERE id = ?').get(taskId) as {
      rework_count: number;
    };
    return row.rework_count;
  }

  get(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | {
          id: string;
          run_id: string;
          goal_id: string | null;
          title: string;
          description: string;
          type: string;
          status: string;
          contract_json: string | null;
          execution_strategy_json: string | null;
          acceptance_criteria_json: string | null;
          rework_count: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    const depRows = this.db
      .prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?')
      .all(taskId) as Array<{ depends_on_task_id: string }>;

    return {
      id: row.id,
      runId: row.run_id,
      goalId: row.goal_id ?? undefined,
      title: row.title,
      description: row.description,
      type: row.type as TaskType,
      status: row.status as TaskStatus,
      contractJson: row.contract_json ?? undefined,
      executionStrategyJson: row.execution_strategy_json ?? undefined,
      acceptanceCriteriaJson: row.acceptance_criteria_json ?? undefined,
      reworkCount: row.rework_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dependencies: depRows.map((d) => d.depends_on_task_id),
    };
  }

  listByRun(runId: string): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Array<{
      id: string;
      run_id: string;
      goal_id: string | null;
      title: string;
      description: string;
      type: string;
      status: string;
      contract_json: string | null;
      execution_strategy_json: string | null;
      acceptance_criteria_json: string | null;
      rework_count: number;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => {
      const depRows = this.db
        .prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?')
        .all(row.id) as Array<{ depends_on_task_id: string }>;

      return {
        id: row.id,
        runId: row.run_id,
        goalId: row.goal_id ?? undefined,
        title: row.title,
        description: row.description,
        type: row.type as TaskType,
        status: row.status as TaskStatus,
        contractJson: row.contract_json ?? undefined,
        executionStrategyJson: row.execution_strategy_json ?? undefined,
        acceptanceCriteriaJson: row.acceptance_criteria_json ?? undefined,
        reworkCount: row.rework_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dependencies: depRows.map((d) => d.depends_on_task_id),
      };
    });
  }
}
