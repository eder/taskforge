import { describe, it, expect } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository } from '@taskforge/persistence';
import { resolveRunRef } from '../src/run-ref.js';

function setup(ids: string[]) {
  const db = new TaskForgeDatabase(':memory:');
  const runs = new RunRepository(db);
  const goals = new GoalRepository(db);
  // oldest first, so the last id is the newest
  ids.forEach((id, i) => {
    goals.create({ id: `g-${id}`, description: id, repository: '/r' });
    runs.create(id, `g-${id}`, {});
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - (ids.length - i) * 60_000).toISOString(),
      id,
    );
  });
  return { db, runs };
}

describe('resolveRunRef', () => {
  const ids = ['run-1790000000001111', 'run-1790000000002222', 'run-1790000000003333'];

  it('resolves last/latest to the newest run', () => {
    const { db, runs } = setup(ids);
    expect(resolveRunRef(runs, 'last')).toEqual({ runId: ids[2] });
    expect(resolveRunRef(runs, 'LATEST')).toEqual({ runId: ids[2] });
    db.close();
  });

  it('resolves list positions as shown by tf runs (1 = newest), with or without #', () => {
    const { db, runs } = setup(ids);
    expect(resolveRunRef(runs, '1')).toEqual({ runId: ids[2] });
    expect(resolveRunRef(runs, '#3')).toEqual({ runId: ids[0] });
    expect(resolveRunRef(runs, '4')).toEqual({ error: expect.stringContaining('only 3 runs') });
    expect(resolveRunRef(runs, '0')).toEqual({ error: expect.stringContaining('no run #0') });
    db.close();
  });

  it('resolves a full id and a unique end or start of an id', () => {
    const { db, runs } = setup(ids);
    expect(resolveRunRef(runs, ids[1])).toEqual({ runId: ids[1] });
    expect(resolveRunRef(runs, '2222')).toEqual({ runId: ids[1] });
    expect(resolveRunRef(runs, 'run-17900000000033')).toEqual({ runId: ids[2] });
    db.close();
  });

  it('refuses an ambiguous fragment instead of guessing, and explains how to fix it', () => {
    const { db, runs } = setup(['run-1790000000001111', 'run-1790000000011111']);
    const result = resolveRunRef(runs, '1111');
    expect(result).toEqual({ error: expect.stringContaining('matches 2 runs') });
    db.close();
  });

  it('explains unknown references and an empty history', () => {
    const { db, runs } = setup(ids);
    expect(resolveRunRef(runs, 'run-nope')).toEqual({ error: expect.stringContaining('not found') });
    expect(resolveRunRef(runs, 'abc')).toEqual({ error: expect.stringContaining('not found') });
    const empty = setup([]);
    expect(resolveRunRef(empty.runs, 'last')).toEqual({ error: 'No runs recorded yet.' });
    db.close();
    empty.db.close();
  });
});
