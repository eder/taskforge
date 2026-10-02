import { TaskForgeDatabase } from '../database.js';

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
