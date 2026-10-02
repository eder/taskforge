import {
  AssignmentStatus,
  AgentAssignment,
  CompletionFailureReason,
} from '@taskforge/shared';
import { TaskForgeDatabase } from '../database.js';

export interface AssignmentRecord {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  role: string;
  objective: string;
  status: AssignmentStatus;
  branchName?: string;
  worktreePath?: string;
  completionReason?: CompletionFailureReason;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSelectionStats {
  agentId: string;
  totalAssignments: number;
  roleAssignments: number;
  lastAssignedAt?: string;
}

export class AssignmentRepository {
  constructor(private db: TaskForgeDatabase) {}

  create(assignment: AgentAssignment, runId: string): AssignmentRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO assignments (
          id, task_id, run_id, agent_id, role, objective, status,
          branch_name, worktree_path, completion_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assignment.id,
        assignment.taskId,
        runId,
        assignment.agentId,
        assignment.role,
        assignment.objective,
        assignment.status,
        assignment.branchName ?? null,
        assignment.worktreePath ?? null,
        assignment.completionReason ?? null,
        now,
        now,
      );

    return {
      id: assignment.id,
      taskId: assignment.taskId,
      runId,
      agentId: assignment.agentId,
      role: assignment.role,
      objective: assignment.objective,
      status: assignment.status,
      branchName: assignment.branchName,
      worktreePath: assignment.worktreePath,
      completionReason: assignment.completionReason,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateStatus(
    id: string,
    status: AssignmentStatus,
    branchName?: string,
    worktreePath?: string,
    completionReason?: CompletionFailureReason,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE assignments SET
          status = ?,
          branch_name = COALESCE(?, branch_name),
          worktree_path = COALESCE(?, worktree_path),
          completion_reason = COALESCE(?, completion_reason),
          updated_at = ?
         WHERE id = ?`,
      )
      .run(status, branchName ?? null, worktreePath ?? null, completionReason ?? null, now, id);
  }

  listByTask(taskId: string): AssignmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM assignments WHERE task_id = ?')
      .all(taskId) as Array<{
      id: string;
      task_id: string;
      run_id: string;
      agent_id: string;
      role: string;
      objective: string;
      status: string;
      branch_name: string | null;
      worktree_path: string | null;
      completion_reason: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      runId: r.run_id,
      agentId: r.agent_id,
      role: r.role,
      objective: r.objective,
      status: r.status as AssignmentStatus,
      branchName: r.branch_name ?? undefined,
      worktreePath: r.worktree_path ?? undefined,
      completionReason: (r.completion_reason as CompletionFailureReason) ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  listByRun(runId: string): AssignmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM assignments WHERE run_id = ?')
      .all(runId) as Array<{
      id: string;
      task_id: string;
      run_id: string;
      agent_id: string;
      role: string;
      objective: string;
      status: string;
      branch_name: string | null;
      worktree_path: string | null;
      completion_reason: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      runId: r.run_id,
      agentId: r.agent_id,
      role: r.role,
      objective: r.objective,
      status: r.status as AssignmentStatus,
      branchName: r.branch_name ?? undefined,
      worktreePath: r.worktree_path ?? undefined,
      completionReason: (r.completion_reason as CompletionFailureReason) ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getAgentSelectionStats(agentId: string, role: string): AgentSelectionStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_assignments,
          COALESCE(SUM(CASE WHEN role = ? THEN 1 ELSE 0 END), 0) as role_assignments,
          MAX(created_at) as last_assigned_at
         FROM assignments
         WHERE agent_id = ?`,
      )
      .get(role, agentId) as
      | {
          total_assignments?: number;
          role_assignments?: number;
          last_assigned_at?: string | null;
        }
      | undefined;

    return {
      agentId,
      totalAssignments: Number(row?.total_assignments ?? 0),
      roleAssignments: Number(row?.role_assignments ?? 0),
      lastAssignedAt: row?.last_assigned_at ?? undefined,
    };
  }

  get(id: string): AssignmentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM assignments WHERE id = ?')
      .get(id) as
      | {
          id: string;
          task_id: string;
          run_id: string;
          agent_id: string;
          role: string;
          objective: string;
          status: string;
          branch_name: string | null;
          worktree_path: string | null;
          completion_reason: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      agentId: row.agent_id,
      role: row.role,
      objective: row.objective,
      status: row.status as AssignmentStatus,
      branchName: row.branch_name ?? undefined,
      worktreePath: row.worktree_path ?? undefined,
      completionReason: (row.completion_reason as CompletionFailureReason) ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
