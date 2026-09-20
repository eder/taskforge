import {
  TaskForgeEvent,
  TaskStatus,
  TaskType,
  AssignmentStatus,
  ExecutionStatus,
  TaskContract,
  AgentAssignment,
  VerificationResult,
  EventType,
  CompletionFailureReason,
} from '@taskforge/shared';
import { TaskForgeDatabase } from './database.js';

export interface RunRecord {
  id: string;
  goalId?: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  metadataJson?: string;
}

export interface GoalRecord {
  id: string;
  description: string;
  repository: string;
  constraintsJson?: string;
  acceptanceCriteriaJson?: string;
  createdAt: string;
}

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

export class RunRepository {
  constructor(private db: TaskForgeDatabase) {}

  create(id: string, goalId?: string, metadata?: Record<string, unknown>): RunRecord {
    const now = new Date().toISOString();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    this.db
      .prepare(
        'INSERT INTO runs (id, goal_id, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, goalId ?? null, 'running', now, metadataJson);

    return {
      id,
      goalId,
      status: 'running',
      createdAt: now,
      metadataJson: metadataJson ?? undefined,
    };
  }

  updateStatus(id: string, status: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE runs SET status = ?, completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END WHERE id = ?",
      )
      .run(status, status, now, id);
  }

  /** Shallow-merges `patch` into the run's existing metadata_json. */
  mergeMetadata(id: string, patch: Record<string, unknown>): void {
    const row = this.db.prepare('SELECT metadata_json FROM runs WHERE id = ?').get(id) as
      | { metadata_json: string | null }
      | undefined;
    const existing = row?.metadata_json ? JSON.parse(row.metadata_json) : {};
    const merged = { ...existing, ...patch };
    this.db
      .prepare('UPDATE runs SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify(merged), id);
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | {
          id: string;
          goal_id: string | null;
          status: string;
          created_at: string;
          completed_at: string | null;
          metadata_json: string | null;
        }
      | undefined;

    if (!row) return undefined;
    return {
      id: row.id,
      goalId: row.goal_id ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      metadataJson: row.metadata_json ?? undefined,
    };
  }

  listAll(): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as Array<{
      id: string;
      goal_id: string | null;
      status: string;
      created_at: string;
      completed_at: string | null;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      goalId: row.goal_id ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      metadataJson: row.metadata_json ?? undefined,
    }));
  }
}

export class GoalRepository {
  constructor(private db: TaskForgeDatabase) {}

  create(goal: {
    id: string;
    description: string;
    repository: string;
    constraints?: unknown[];
    acceptanceCriteria?: string[];
  }): GoalRecord {
    const now = new Date().toISOString();
    const constraintsJson = goal.constraints ? JSON.stringify(goal.constraints) : null;
    const acceptanceCriteriaJson = goal.acceptanceCriteria
      ? JSON.stringify(goal.acceptanceCriteria)
      : null;

    this.db
      .prepare(
        'INSERT INTO goals (id, description, repository, constraints_json, acceptance_criteria_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        goal.id,
        goal.description,
        goal.repository,
        constraintsJson,
        acceptanceCriteriaJson,
        now,
      );

    return {
      id: goal.id,
      description: goal.description,
      repository: goal.repository,
      constraintsJson: constraintsJson ?? undefined,
      acceptanceCriteriaJson: acceptanceCriteriaJson ?? undefined,
      createdAt: now,
    };
  }

  get(id: string): GoalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as
      | {
          id: string;
          description: string;
          repository: string;
          constraints_json: string | null;
          acceptance_criteria_json: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      id: row.id,
      description: row.description,
      repository: row.repository,
      constraintsJson: row.constraints_json ?? undefined,
      acceptanceCriteriaJson: row.acceptance_criteria_json ?? undefined,
      createdAt: row.created_at,
    };
  }
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

export class EventRepository {
  constructor(private db: TaskForgeDatabase) {}

  append(event: TaskForgeEvent): void {
    this.db
      .prepare(
        'INSERT INTO events (id, run_id, task_id, type, payload_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        event.id,
        event.runId,
        event.taskId ?? null,
        event.type,
        JSON.stringify(event.payload),
        event.timestamp.toISOString(),
      );
  }

  listByRun(runId: string): TaskForgeEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY timestamp ASC')
      .all(runId) as Array<{
      id: string;
      run_id: string;
      task_id: string | null;
      type: string;
      payload_json: string;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      taskId: r.task_id ?? undefined,
      type: r.type as EventType,
      payload: JSON.parse(r.payload_json),
      timestamp: new Date(r.timestamp),
    }));
  }

  listByTask(taskId: string): TaskForgeEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY timestamp ASC')
      .all(taskId) as Array<{
      id: string;
      run_id: string;
      task_id: string | null;
      type: string;
      payload_json: string;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      taskId: r.task_id ?? undefined,
      type: r.type as EventType,
      payload: JSON.parse(r.payload_json),
      timestamp: new Date(r.timestamp),
    }));
  }
}

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
}

export class WorkspaceRepository {
  constructor(private db: TaskForgeDatabase) {}

  register(record: {
    id: string;
    runId: string;
    taskId: string;
    assignmentId: string;
    path: string;
    branch: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO workspaces (id, run_id, task_id, assignment_id, path, branch, is_clean, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      )
      .run(
        record.id,
        record.runId,
        record.taskId,
        record.assignmentId,
        record.path,
        record.branch,
        now,
      );
  }

  markDeleted(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(now, id);
  }
}

export interface RunAuditReport {
  run: RunRecord;
  goal?: GoalRecord;
  tasks: TaskRecord[];
  events: TaskForgeEvent[];
}

export class AuditService {
  constructor(
    private runRepo: RunRepository,
    private goalRepo: GoalRepository,
    private taskRepo: TaskRepository,
    private eventRepo: EventRepository,
  ) {}

  reconstructRun(runId: string): RunAuditReport | undefined {
    const run = this.runRepo.get(runId);
    if (!run) return undefined;

    const goal = run.goalId ? this.goalRepo.get(run.goalId) : undefined;
    const tasks = this.taskRepo.listByRun(runId);
    const events = this.eventRepo.listByRun(runId);

    return {
      run,
      goal,
      tasks,
      events,
    };
  }
}

export interface CostRecord {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  createdAt: string;
}

export class CostRepository {
  constructor(private db: TaskForgeDatabase) {}

  record(item: {
    id: string;
    runId: string;
    taskId: string;
    agentId: string;
    modelName: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  }): CostRecord {
    const now = new Date().toISOString();
    const inputTokens = item.inputTokens ?? 0;
    const outputTokens = item.outputTokens ?? 0;
    const estimatedCostUsd = item.estimatedCostUsd ?? 0.0;

    this.db
      .prepare(
        `INSERT INTO cost_tracking (
          id, run_id, task_id, agent_id, model_name,
          input_tokens, output_tokens, estimated_cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.runId,
        item.taskId,
        item.agentId,
        item.modelName,
        inputTokens,
        outputTokens,
        estimatedCostUsd,
        now,
      );

    return {
      id: item.id,
      runId: item.runId,
      taskId: item.taskId,
      agentId: item.agentId,
      modelName: item.modelName,
      inputTokens,
      outputTokens,
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
      agent_id: string;
      model_name: string;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      taskId: r.task_id,
      agentId: r.agent_id,
      modelName: r.model_name,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      estimatedCostUsd: r.estimated_cost_usd,
      createdAt: r.created_at,
    }));
  }

  getTotalCostByRun(runId: string): {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(estimated_cost_usd), 0.0) as total_cost,
          COALESCE(SUM(input_tokens), 0) as total_input,
          COALESCE(SUM(output_tokens), 0) as total_output
        FROM cost_tracking WHERE run_id = ?`,
      )
      .get(runId) as { total_cost: number; total_input: number; total_output: number } | undefined;

    return {
      totalCostUsd: row?.total_cost ?? 0.0,
      totalInputTokens: row?.total_input ?? 0,
      totalOutputTokens: row?.total_output ?? 0,
    };
  }
}

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
