import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository, SessionRepository } from '@taskforge/persistence';
import { OperatorIntentParser } from '@taskforge/operator';
import { InteractiveShell } from '../src/interactive-shell.js';
import { SLASH_COMMANDS } from '../src/slash-menu.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('session: /clear, tf --new and continuation', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  const seedRun = (id: string, ageHours: number) => {
    new GoalRepository(db).create({ id: `g-${id}`, description: 'Analyse the project', repository: tmpDir });
    const runs = new RunRepository(db);
    runs.create(id, `g-${id}`, { taskOutputs: { T1: 'report body' } });
    runs.updateStatus(id, 'completed');
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - ageHours * 3_600_000).toISOString(),
      id,
    );
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-session-test-'));
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

  it('stores and returns the context boundary', () => {
    const sessions = new SessionRepository(db);
    expect(sessions.getContextBoundary()).toBeUndefined();
    const at = new Date('2026-10-02T12:00:00Z');
    sessions.clearContext(at);
    expect(sessions.getContextBoundary()?.toISOString()).toBe(at.toISOString());
    sessions.clearContext(new Date('2026-10-03T00:00:00Z'));
    expect(sessions.getContextBoundary()?.toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });

  it('/clear stops earlier runs from being attached, but keeps them in the history', async () => {
    seedRun('run-1790000000000001', 1);
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    (shell as any).planner.setEarlierRunSelector(async () => ({ earlierRunId: 'run-1790000000000001' }));

    const before = plain(await shell.handleInput('implement item 1 and add regression tests'));
    expect(before).toContain('Context: using the output of run-1790000000000001');

    const cleared = plain(await shell.handleInput('/clear'));
    expect(cleared).toContain('Context cleared');
    expect(new RunRepository(db).get('run-1790000000000001')).toBeDefined();

    const after = plain(await shell.handleInput('implement item 1 and add regression tests'));
    expect(after).not.toContain('Context: using the output');
  });

  it('/clear discards a plan that is waiting for approval, and says so', async () => {
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    await shell.handleInput('implement password reset with token expiry and add tests');
    const cleared = plain(await shell.handleInput('/clear'));
    expect(cleared).toContain('pending plan was discarded');
    expect((shell as any).currentGraph).toBeUndefined();
  });

  it('a run created after /clear is used again', async () => {
    seedRun('run-1790000000000002', 5);
    new SessionRepository(db).clearContext(new Date(Date.now() - 3_600_000));
    seedRun('run-1790000000000003', 0.5);
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    (shell as any).planner.setEarlierRunSelector(async (m: Array<{ content: string }>) => {
      const ids = (JSON.parse(m[1].content).recentRuns as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(['run-1790000000000003']);
      return { earlierRunId: ids[0] };
    });
    const reply = plain(await shell.handleInput('implement item 1 and add regression tests'));
    expect(reply).toContain('Context: using the output of run-1790000000000003');
  });

  it('shows what the session continues from, and nothing for a fresh session', () => {
    seedRun('run-1790000000000004', 2);
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    const hint = plain((shell as any).continuationHint());
    expect(hint).toContain('Continuing from run-1790000000000004');
    expect(hint).toContain('/clear');
    shell.close();

    shell = new InteractiveShell({ repoRoot: tmpDir, database: db, freshSession: true });
    expect((shell as any).continuationHint()).toBe('');
  });

  it('shows no continuation after /clear until a new run exists', async () => {
    seedRun('run-1790000000000005', 2);
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    await shell.handleInput('/clear');
    expect((shell as any).continuationHint()).toBe('');
  });

  it('/unpause and the old /resume both continue a paused execution; /clear is its own command', () => {
    expect(OperatorIntentParser.parse('/unpause').type).toBe('resume_execution');
    expect(OperatorIntentParser.parse('/resume').type).toBe('resume_execution');
    expect(OperatorIntentParser.parse('/clear').type).toBe('clear_context');
    const names = SLASH_COMMANDS.map((c) => c.cmd);
    expect(names).toContain('/unpause');
    expect(names).toContain('/clear');
    expect(names).not.toContain('/resume');
  });
});
