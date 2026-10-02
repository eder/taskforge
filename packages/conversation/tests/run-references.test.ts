import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

describe('REPL run references', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ref-test-'));
    db = new TaskForgeDatabase(path.join(tmpDir, 'test.db'));
  });
  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves "last" and a list number to a real run before looking it up', () => {
    const goals = new GoalRepository(db);
    const runs = new RunRepository(db);
    for (const id of ['run-1790000000001111', 'run-1790000000002222']) {
      goals.create({ id: `g-${id}`, description: id, repository: tmpDir });
      runs.create(id, `g-${id}`, {});
    }
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', 'run-1790000000001111');
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-02-01T00:00:00.000Z', 'run-1790000000002222');
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });

    const resolve = (ref?: string) => (shell as any).resolveDeliveryRunId(ref);
    expect(resolve('last')).toBe('run-1790000000002222');
    expect(resolve('#2')).toBe('run-1790000000001111');
    expect(resolve('1111')).toBe('run-1790000000001111');
    expect(resolve('run-unknown')).toBe('run-unknown');
  });
});
