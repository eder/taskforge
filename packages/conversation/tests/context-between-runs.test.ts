import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('context between runs in the shell', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  function seedRun(id: string, ageHours: number, outputs: Record<string, string>, status = 'completed') {
    new GoalRepository(db).create({ id: `g-${id}`, description: 'Analyse the project', repository: tmpDir });
    const runs = new RunRepository(db);
    runs.create(id, `g-${id}`, { taskOutputs: outputs });
    runs.updateStatus(id, status);
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - ageHours * 3_600_000).toISOString(),
      id,
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ctx-test-'));
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

  it('attaches the last run report when the message refers to earlier work, and says so in the plan', async () => {
    seedRun('run-1790000000000001', 1, { T1: '1. Fix the retry loop\n2. Add tests' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });

    const reply = plain(await shell.handleInput('implement item 1 and add regression tests'));

    expect(reply).toContain('Plan Proposal');
    expect(reply).toContain('Context: using the output of run-1790000000000001');
    expect(reply).toContain('sem contexto');
  });

  it('attaches nothing when the user opts out', async () => {
    seedRun('run-1790000000000002', 1, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });

    const reply = plain(await shell.handleInput('implement item 1 sem contexto, add retry tests'));

    expect(reply).not.toContain('Context: using the output');
  });

  it('attaches nothing from a stale run, and says that no earlier output was found', async () => {
    seedRun('run-1790000000000003', 72, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });

    const reply = plain(await shell.handleInput('implement item 1 and add regression tests'));

    expect(reply).not.toContain('Context: using the output');
    expect(reply).toContain('no recent');
  });

  it('does not attach anything to a self-contained request', async () => {
    seedRun('run-1790000000000004', 1, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });

    const reply = plain(await shell.handleInput('implement password reset with token expiry and add tests'));

    expect(reply).not.toContain('Context: using');
  });
});
