import {
  TaskForgeEvent,
  EventType,
} from '@taskforge/shared';
import { TaskForgeDatabase } from '../database.js';

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
