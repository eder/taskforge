import { TaskForgeDatabase } from '../database.js';

export interface RunRecord {
  id: string;
  goalId?: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  metadataJson?: string;
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
