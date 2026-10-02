import { TaskForgeDatabase } from '../database.js';

const CONTEXT_BOUNDARY = 'context_boundary';

/**
 * What the REPL remembers between launches. TaskForge keeps no chat transcript:
 * what carries over is the run history, and this is the one switch over it.
 * A "context boundary" is the moment the user said "start fresh" (`/clear`,
 * `tf --new`); runs created before it are no longer offered as context.
 */
export class SessionRepository {
  constructor(private db: TaskForgeDatabase) {}

  /** When the user last cleared the context, if ever. */
  getContextBoundary(): Date | undefined {
    const row = this.db.prepare('SELECT value FROM session_state WHERE key = ?').get(CONTEXT_BOUNDARY) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    const date = new Date(row.value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  clearContext(now: Date = new Date()): void {
    const iso = now.toISOString();
    this.db
      .prepare(
        'INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(CONTEXT_BOUNDARY, iso, iso);
  }
}
