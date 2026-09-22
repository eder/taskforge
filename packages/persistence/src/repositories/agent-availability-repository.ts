import { TaskForgeDatabase } from '../database.js';

export interface PersistedAgentAvailability {
  agentId: string;
  status: string;
  reason?: string;
  recordedAt: number;
  resetAt?: number;
  source: string;
}

export class AgentAvailabilityRepository {
  constructor(private db: TaskForgeDatabase) {}

  upsert(record: PersistedAgentAvailability): void {
    this.db
      .prepare(
        `INSERT INTO agent_availability (
          agent_id, status, reason, recorded_at, reset_at, source
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          status = excluded.status,
          reason = excluded.reason,
          recorded_at = excluded.recorded_at,
          reset_at = excluded.reset_at,
          source = excluded.source`,
      )
      .run(
        record.agentId,
        record.status,
        record.reason ?? null,
        record.recordedAt,
        record.resetAt ?? null,
        record.source,
      );
  }

  get(agentId: string): PersistedAgentAvailability | undefined {
    const row = this.db
      .prepare(
        `SELECT agent_id, status, reason, recorded_at, reset_at, source
         FROM agent_availability WHERE agent_id = ?`,
      )
      .get(agentId) as
      | {
          agent_id: string;
          status: string;
          reason: string | null;
          recorded_at: number;
          reset_at: number | null;
          source: string;
        }
      | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  list(): PersistedAgentAvailability[] {
    const rows = this.db
      .prepare(
        `SELECT agent_id, status, reason, recorded_at, reset_at, source
         FROM agent_availability ORDER BY agent_id`,
      )
      .all() as Array<{
      agent_id: string;
      status: string;
      reason: string | null;
      recorded_at: number;
      reset_at: number | null;
      source: string;
    }>;

    return rows.map((row) => this.mapRow(row));
  }

  delete(agentId: string): void {
    this.db.prepare('DELETE FROM agent_availability WHERE agent_id = ?').run(agentId);
  }

  clear(): void {
    this.db.exec('DELETE FROM agent_availability;');
  }

  /**
   * Merge still-active provider failures from a legacy/project-local store
   * into this repository. Newer records win so opening an older project can
   * never overwrite fresher global availability state.
   */
  mergeFrom(source: AgentAvailabilityRepository, now = Date.now()): number {
    const persistable = new Set(['quota_exhausted', 'rate_limited', 'auth_failed']);
    let merged = 0;

    for (const record of source.list()) {
      if (!persistable.has(record.status)) continue;
      if (record.resetAt !== undefined && record.resetAt <= now) continue;

      const existing = this.get(record.agentId);
      if (existing && existing.recordedAt >= record.recordedAt) continue;

      this.upsert(record);
      merged++;
    }

    return merged;
  }

  private mapRow(row: {
    agent_id: string;
    status: string;
    reason: string | null;
    recorded_at: number;
    reset_at: number | null;
    source: string;
  }): PersistedAgentAvailability {
    return {
      agentId: row.agent_id,
      status: row.status,
      reason: row.reason ?? undefined,
      recordedAt: Number(row.recorded_at),
      resetAt: row.reset_at == null ? undefined : Number(row.reset_at),
      source: row.source,
    };
  }
}
