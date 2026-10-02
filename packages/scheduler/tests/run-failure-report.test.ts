import { describe, it, expect } from 'vitest';
import { TaskForgeDatabase, RunRepository, TaskRepository, EventRepository } from '@taskforge/persistence';
import {
  describeRunFailures,
  formatRunFailureLines,
  recommendNextStep,
  type RunFailureLine,
} from '../src/run-failure-report.js';

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
    expect(lines).toMatchObject([
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

describe('a failed check is summarized, not dumped', () => {
  it('shows the headline and the first output line, and flags a broken verification command', () => {
    const { db, addTask, addEvent, deps } = setup();
    addTask('T1', 'blocked');
    addEvent('T1', 'TASK_RECOVERY_BLOCKED', {
      failureClass: 'verification_configuration',
      reason: "Check 'explicit-1' failed with exit code 2\nCommand: pytest -q\nLast output:\nFAILED t.py::t - async def functions are not natively supported.\n139 failed",
    });
    const reason = describeRunFailures(deps, 'run-1')[0].reason!;
    expect(reason).toBe(
      "The verification command does not work for this project: Check 'explicit-1' failed with exit code 2 — FAILED t.py::t - async def functions are not natively supported.",
    );
    expect(reason).not.toContain('Command:');
    db.close();
  });
});

describe('completion codes are shown in words', () => {
  it('explains NO_CHANGES_PRODUCED, including in runs recorded with the bare code', () => {
    const { db, addTask, addEvent, deps } = setup();
    addTask('T1', 'blocked');
    addEvent('T1', 'TASK_RECOVERY_BLOCKED', { reason: 'NO_CHANGES_PRODUCED', evidence: "IMPLEMENTATION task 'T1' produced zero file modifications" });
    const reason = describeRunFailures(deps, 'run-1')[0].reason!;
    expect(reason).toContain('finished without changing any file');
    expect(reason).toContain('may already exist');
    expect(reason).not.toMatch(/^NO_CHANGES_PRODUCED$/);
    db.close();
  });
});

describe('kept work in the failure report', () => {
  it('names the branch holding the work and the no-agent resume path', () => {
    const { db, addTask, addEvent, deps } = setup();
    addTask('T1', 'blocked');
    addEvent('T1', 'TASK_FAILED', { reason: 'Verification failed: exit code 2' });
    addEvent('T1', 'TASK_CANDIDATE_PRESERVED', { branch: 'taskforge/candidate/123/T1', commit: 'abc' });
    const lines = describeRunFailures(deps, 'run-1');
    expect(lines[0].keptBranch).toBe('taskforge/candidate/123/T1');
    const text = formatRunFailureLines(lines, 'run-1').join('\n');
    expect(text).toContain("work is kept on branch taskforge/candidate/123/T1");
    expect(text).toContain('continues from its kept work');
    db.close();
  });
});

describe('formatRunFailureLines', () => {
  it('is empty when there is nothing to explain, and always ends with the next step', () => {
    expect(formatRunFailureLines([], 'run-1')).toEqual([]);
    const text = formatRunFailureLines([{ taskId: 'T1', title: 'x', kind: 'failed', reason: 'boom' }], 'run-9');
    expect(text.some((l) => l.startsWith('Next: tf resume run-9'))).toBe(true);
    expect(text[text.length - 1]).toBe('Also: tf abandon run-9 (if no longer needed)   ·   tf inspect run-9');
  });
});

describe('recommendNextStep', () => {
  const line = (over: Partial<RunFailureLine>): RunFailureLine => ({ taskId: 'T1', title: 'x', kind: 'blocked', ...over });

  it('is nothing when there is nothing to explain', () => {
    expect(recommendNextStep([], 'run-1')).toBeUndefined();
  });

  it('points a broken check command at tf init --check, and is not offered as a one-key action', () => {
    const step = recommendNextStep([line({ failureClass: 'verification_configuration' })], 'run-1')!;
    expect(step.command).toBe('tf init --check');
    expect(step.runnable).toBe(false);
    expect(step.alternatives).toContain('tf resume run-1');
  });

  it('asks for the environment fix before resuming', () => {
    const step = recommendNextStep([line({ failureClass: 'environment' })], 'run-1')!;
    expect(step.command).toBe('tf resume run-1');
    expect(step.runnable).toBe(false);
  });

  it('suggests a higher budget after a budget stop, never one-key', () => {
    const step = recommendNextStep(
      [{ taskId: '', title: '', kind: 'budget', budget: { spent: 620_000, budget: 500_000 } }],
      'run-1',
    )!;
    expect(step.command).toBe('tf resume run-1 --budget 1000000');
    expect(step.runnable).toBe(false);
  });

  it('suggests resuming a code failure, runnable with one key, and mentions --fresh when work was kept', () => {
    const plain = recommendNextStep([line({ kind: 'failed' })], 'run-1')!;
    expect(plain).toMatchObject({ command: 'tf resume run-1', runnable: true });
    const kept = recommendNextStep([line({ kind: 'failed', keptBranch: 'taskforge/candidate/1/T1' })], 'run-1')!;
    expect(kept.alternatives.join(' ')).toContain('--fresh');
  });

  it('gives one command, not a menu, in the formatted output', () => {
    const text = formatRunFailureLines([line({ failureClass: 'verification_configuration' })], 'run-1');
    expect(text.filter((l) => l.startsWith('Next:'))).toHaveLength(1);
    expect(text.join('\n')).toContain('Next: tf init --check');
  });
});
