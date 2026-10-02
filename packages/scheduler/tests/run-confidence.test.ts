import { describe, it, expect } from 'vitest';
import {
  TaskForgeDatabase,
  RunRepository,
  TaskRepository,
  VerificationRepository,
  EventRepository,
} from '@taskforge/persistence';
import { describeRunConfidence, formatRunConfidence } from '../src/run-confidence.js';

function setup() {
  const db = new TaskForgeDatabase(':memory:');
  new RunRepository(db).create('run-1', undefined, {});
  const taskRepo = new TaskRepository(db);
  const verificationRepo = new VerificationRepository(db);
  const eventRepo = new EventRepository(db);
  const addTask = (id: string, type: string, status = 'integrated', contract?: object) => {
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, contract_json, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(id, 'run-1', `Title ${id}`, id, type, status, contract ? JSON.stringify(contract) : null, new Date().toISOString(), new Date().toISOString());
  };
  const verify = (taskId: string, names: string[], passed = true) =>
    verificationRepo.save(taskId, 'run-1', {
      passed,
      checks: names.map((name) => ({ name, command: name, exitCode: 0, stdout: '', stderr: '', durationMs: 1, success: true })),
    });
  return { db, deps: { taskRepo, verificationRepo, eventRepo }, addTask, verify };
}

describe('describeRunConfidence', () => {
  it('is verified when every changing task ran checks that passed', () => {
    const { db, deps, addTask, verify } = setup();
    addTask('T1', 'implementation');
    verify('T1', ['test', 'lint']);
    const c = describeRunConfidence(deps, 'run-1');
    expect(c.headline).toBe('verified');
    expect(formatRunConfidence(c).join('\n')).toContain('test, lint passed');
    db.close();
  });

  it('says plainly when a "passing" task had no checks at all', () => {
    const { db, deps, addTask, verify } = setup();
    addTask('T1', 'implementation');
    verify('T1', []); // passed, but nothing ran (e.g. documentation-only)
    const c = describeRunConfidence(deps, 'run-1');
    expect(c.headline).toBe('unverified');
    const text = formatRunConfidence(c, 'Update the docs').join('\n');
    expect(text).toContain('What it does: Update the docs');
    expect(text).toContain('no automated checks ran');
    expect(text).toContain('Read the diff before applying');
    db.close();
  });

  it('is partly verified when only some tasks were checked', () => {
    const { db, deps, addTask, verify } = setup();
    addTask('T1', 'implementation');
    addTask('T2', 'implementation');
    verify('T1', ['test']);
    const c = describeRunConfidence(deps, 'run-1');
    expect(c.headline).toBe('partly_verified');
    expect(formatRunConfidence(c).join('\n')).toContain('Partly verified');
    db.close();
  });

  it('read-only tasks are not counted against a run, and a read-only run needs no checks', () => {
    const { db, deps, addTask } = setup();
    addTask('T1', 'investigation');
    addTask('T2', 'implementation', 'failed'); // never integrated: not part of what is delivered
    const c = describeRunConfidence(deps, 'run-1');
    expect(c.headline).toBe('not_applicable');
    expect(formatRunConfidence(c).join('\n')).toContain('nothing to check');
    db.close();
  });

  it('lists independent reviewers', () => {
    const { db, deps, addTask, verify } = setup();
    addTask('T1', 'implementation');
    verify('T1', ['test']);
    deps.eventRepo.append({
      id: 'e1',
      runId: 'run-1',
      taskId: 'T1',
      type: 'DUAL_REVIEW_APPROVED',
      payload: { reviewerId: 'codex' },
      timestamp: new Date(),
    });
    const c = describeRunConfidence(deps, 'run-1');
    expect(c.reviewedBy).toEqual(['codex']);
    expect(formatRunConfidence(c).join('\n')).toContain('approved by codex');
    db.close();
  });
});
