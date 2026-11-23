import { TaskForgeDatabase } from '../database.js';

const CONTEXT_BOUNDARY = 'context_boundary';
const DIRECT_SESSION_STATE = 'direct_session_state';

export interface PersistedDirectSessionState {
  entries: Array<Record<string, unknown>>;
  seq: number;
  providerSessions: Record<string, { sessionId: string; lastSeq: number }>;
  stickyAgentMode?: string;
}

/**
 * What the REPL remembers between launches:
 * 1. `context_boundary` — the moment the user said "start fresh" (`/clear`, `tf --new`).
 * 2. `direct_session_state` — rolling Direct Mode cross-agent memory, native provider
 *    session/thread IDs (`claude --resume`, `codex exec resume`, `agy --conversation`),
 *    and sticky target mode so reopening `tf` resumes seamlessly.
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
    this.clearDirectSessionState();
  }

  getDirectSessionState(): PersistedDirectSessionState | undefined {
    const row = this.db
      .prepare('SELECT value FROM session_state WHERE key = ?')
      .get(DIRECT_SESSION_STATE) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value) as PersistedDirectSessionState;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
        return undefined;
      }
      return {
        entries: parsed.entries,
        seq: typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : parsed.entries.length,
        providerSessions:
          parsed.providerSessions && typeof parsed.providerSessions === 'object'
            ? parsed.providerSessions
            : {},
        stickyAgentMode:
          typeof parsed.stickyAgentMode === 'string' ? parsed.stickyAgentMode : undefined,
      };
    } catch {
      return undefined;
    }
  }

  saveDirectSessionState(state: PersistedDirectSessionState): void {
    const iso = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(DIRECT_SESSION_STATE, JSON.stringify(state), iso);
  }

  clearDirectSessionState(): void {
    this.db.prepare('DELETE FROM session_state WHERE key = ?').run(DIRECT_SESSION_STATE);
  }
}
