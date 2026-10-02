import {
  ExecutionStatus,
} from '@taskforge/shared';
import { TaskForgeDatabase } from '../database.js';

export interface ExecutionRecord {
  id: string;
  runId: string;
  taskId: string;
  assignmentId: string;
  agentId: string;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  status: ExecutionStatus;
  logPath?: string;
  errorMessage?: string;
}

export class ExecutionRepository {
  constructor(private db: TaskForgeDatabase) {}

  create(execution: {
    id: string;
    runId: string;
    taskId: string;
    assignmentId: string;
    agentId: string;
    pid?: number;
    logPath?: string;
  }): ExecutionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO executions (
          id, run_id, task_id, assignment_id, agent_id, pid,
          started_at, status, log_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        execution.id,
        execution.runId,
        execution.taskId,
        execution.assignmentId,
        execution.agentId,
        execution.pid ?? null,
        now,
        execution.logPath ?? null,
      );

    return {
      id: execution.id,
      runId: execution.runId,
      taskId: execution.taskId,
      assignmentId: execution.assignmentId,
      agentId: execution.agentId,
      pid: execution.pid,
      startedAt: now,
      status: 'running',
      logPath: execution.logPath,
    };
  }

  complete(id: string, status: ExecutionStatus, exitCode?: number, errorMessage?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE executions SET status = ?, finished_at = ?, exit_code = ?, error_message = ? WHERE id = ?',
      )
      .run(status, now, exitCode ?? null, errorMessage ?? null, id);
  }

  listByTask(taskId: string): ExecutionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM executions WHERE task_id = ?')
      .all(taskId) as Array<{
      id: string;
      run_id: string;
      task_id: string;
      assignment_id: string;
      agent_id: string;
      pid: number | null;
      started_at: string;
      finished_at: string | null;
      exit_code: number | null;
      status: string;
      log_path: string | null;
      error_message: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      taskId: r.task_id,
      assignmentId: r.assignment_id,
      agentId: r.agent_id,
      pid: r.pid ?? undefined,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      exitCode: r.exit_code ?? undefined,
      status: r.status as ExecutionStatus,
      logPath: r.log_path ?? undefined,
      errorMessage: r.error_message ?? undefined,
    }));
  }

  listByRun(runId: string): ExecutionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM executions WHERE run_id = ?')
      .all(runId) as Array<{
      id: string;
      run_id: string;
      task_id: string;
      assignment_id: string;
      agent_id: string;
      pid: number | null;
      started_at: string;
      finished_at: string | null;
      exit_code: number | null;
      status: string;
      log_path: string | null;
      error_message: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      taskId: r.task_id,
      assignmentId: r.assignment_id,
      agentId: r.agent_id,
      pid: r.pid ?? undefined,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      exitCode: r.exit_code ?? undefined,
      status: r.status as ExecutionStatus,
      logPath: r.log_path ?? undefined,
      errorMessage: r.error_message ?? undefined,
    }));
  }
}
