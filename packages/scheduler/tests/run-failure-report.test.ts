import { describe, it, expect } from 'vitest';
import { TaskForgeDatabase, RunRepository, TaskRepository, EventRepository } from '@taskforge/persistence';
import { describeRunFailures, formatRunFailureLines } from '../src/run-failure-report.js';

function setup() {
  const db = new TaskForgeDatabase(':memory:');
  new RunRepository(db).create('run-1');
  const tasks = new TaskRepository(db);
  const events = new EventRepository(db);
  const addTask = (id: string, status: string, dependencies: string[] = []) =>
    tasks.create({ id, runId: 'run-1', title: `Title ${id}`, description: 'd', type: 'implementation', status: status as never, dependencies });
  let n = 0;
  const addEvent = (taskId: string, type: string, payload: Record<string, unknown>) =>
    events.append({ id: `e${n}`, runId: 'run-1', taskId, type: type as never, payload, timestamp: new Date(1_000_000 + n++ * 1000) });
  return { db, tasks, addTask, addEvent, deps: { taskRepo: tasks, eventRepo: events } };
}

describe('describeRunFailures', () => {
  it('reports nothing for a run where every task finished', () => {
    const { db, addTask, deps } = setup();
    addTask('T1', 'integrated');
    expect(describeRunFailures(deps, 'run-1')).toEqual([]);
    db.close();
  });

  it('uses the most recent recorded reason and lists dependents as not started', () => {
    const { db, addTask, addEvent, deps } = setup();
    addTask('T1', 'integrated');
    addTask('T2', 'blocked', ['T1']);
    addTask('T3', 'accepted', ['T2']);
    addEvent('T2', 'TASK_RECOVERY_SCHEDULED', { reason: 'older attempt failed', evidence: 'x' });
    addEvent('T2', 'TASK_FAILED', { reason: 'Verification is not configured for this scope' });

    const lines = describeRunFailures(deps, 'run-1');
    expect(lines).toEqual([
      { taskId: 'T2', title: 'Title T2', kind: 'blocked', reason: 'Verification is not configured for this scope' },
      { taskId: 'T3', title: 'Title T3', kind: 'not_started', waitingOn: ['T2'] },
    ]);
    db.close();
  });

  it('falls back through the existing event types (older runs have no TASK_FAILED)', () => {
    const { db, addTask, addEvent, deps } = setup();
    addTask('A', 'failed');
    addTask('B', 'failed');
    addTask('C', 'failed');
    addEvent('A', 'ROUTING_INVALID_FOR_TASK', { reason: 'no implementer staffed' });
    addEvent('B', 'COMPLETION_GATE_REJECTED', { evidence: { explanation: 'report was empty' } });
    addEvent('C', 'SCOPE_VIOLATION', { violations: ['a.py', 'b.py'] });

    const byId = Object.fromEntries(describeRunFailures(deps, 'run-1').map((l) => [l.taskId, l.reason]));
    expect(byId.A).toBe('no implementer staffed');
    expect(byId.B).toBe('report was empty');
    expect(byId.C).toContain('a.py, b.py');
    db.close();
  });

  it('says so honestly when no reason was recorded', () => {
    const { db, addTask, deps } = setup();
    addTask('T1', 'failed');
    const lines = describeRunFailures(deps, 'run-1');
    expect(lines[0].reason).toBeUndefined();
    expect(formatRunFailureLines(lines, 'run-1').join('\n')).toContain('no reason was recorded; run "tf inspect run-1"');
    db.close();
  });
});

describe('formatRunFailureLines', () => {
  it('is empty when there is nothing to explain, and always ends with the next step', () => {
    expect(formatRunFailureLines([], 'run-1')).toEqual([]);
    const text = formatRunFailureLines([{ taskId: 'T1', title: 'x', kind: 'failed', reason: 'boom' }], 'run-9');
    expect(text[text.length - 1]).toBe('Next: tf resume run-9   ·   tf inspect run-9');
  });
});
