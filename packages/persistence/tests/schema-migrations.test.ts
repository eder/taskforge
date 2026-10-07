import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskForgeDatabase } from '../src/database.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-migrations-'));
  dbPath = path.join(dir, 'tf.sqlite');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A database as written before schema versioning: user_version 0 and the old column sets. */
function createLegacyDatabase(): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT);
    CREATE TABLE assignments (id TEXT PRIMARY KEY, task_id TEXT);
    CREATE TABLE cost_tracking (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      model_name TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE verification_results (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, passed INTEGER NOT NULL,
      checks_json TEXT, failure_reason TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    INSERT INTO runs VALUES ('r1');
    INSERT INTO tasks VALUES ('t1', 'r1');
    INSERT INTO cost_tracking VALUES ('c1', 'r1', 't1', 'codex', 'gpt', 10, 5, 0.5, 'now');
    INSERT INTO verification_results VALUES ('v1', 'r1', 't1', 1, '[]', NULL, 'now');
  `);
  raw.close();
}

function userVersion(): number {
  const raw = new DatabaseSync(dbPath);
  try {
    return Number(raw.prepare('PRAGMA user_version;').get().user_version);
  } finally {
    raw.close();
  }
}

describe('schema migrations', () => {
  it('stamps a fresh database with the latest version and the full column set', () => {
    const db = new TaskForgeDatabase(dbPath);
    expect(db.hasColumn('cost_tracking', 'planned_estimated_tokens')).toBe(true);
    expect(db.hasColumn('assignments', 'completion_reason')).toBe(true);
    db.close();
    expect(userVersion()).toBeGreaterThan(0);
  });

  it('upgrades a pre-versioning database and keeps its rows', () => {
    createLegacyDatabase();

    const db = new TaskForgeDatabase(dbPath);

    expect(db.hasColumn('cost_tracking', 'total_tokens')).toBe(true);
    expect(db.hasColumn('assignments', 'completion_reason')).toBe(true);
    const cost = db
      .prepare("SELECT input_tokens, usage_source FROM cost_tracking WHERE id = 'c1'")
      .get();
    expect(cost).toMatchObject({ input_tokens: 10, usage_source: 'provider_reported' });
    // The rebuilt table no longer requires task_id to reference a task.
    expect(db.prepare("SELECT id FROM verification_results WHERE id = 'v1'").get()).toBeTruthy();
    expect(() =>
      db.exec(
        "INSERT INTO verification_results VALUES ('v2', 'r1', 'run-level', 1, '[]', NULL, 'now')",
      ),
    ).not.toThrow();
    db.close();
    expect(userVersion()).toBeGreaterThan(0);
  });

  it('is a no-op when reopened', () => {
    createLegacyDatabase();
    new TaskForgeDatabase(dbPath).close();
    const before = userVersion();

    const db = new TaskForgeDatabase(dbPath);
    expect(db.prepare('SELECT count(*) AS n FROM cost_tracking').get()).toMatchObject({ n: 1 });
    db.close();
    expect(userVersion()).toBe(before);
  });

  it('refuses a database written by a newer TaskForge without touching it', () => {
    new TaskForgeDatabase(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 9999;');
    raw.close();

    expect(() => new TaskForgeDatabase(dbPath)).toThrow(/newer TaskForge/);
    expect(userVersion()).toBe(9999);
  });
});
