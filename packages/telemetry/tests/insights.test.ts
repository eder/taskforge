import { describe, it, expect } from 'vitest';
import {
  TaskForgeDatabase,
  RunRepository,
  EventRepository,
  CostRepository,
} from '@taskforge/persistence';
import { computeInsights, formatInsights } from '../src/insights.js';

function setup() {
  const db = new TaskForgeDatabase(':memory:');
  const runs = new RunRepository(db);
  const events = new EventRepository(db);
  const costs = new CostRepository(db);
  const addRun = (id: string, status: string, ageDays = 1) => {
    runs.create(id, undefined, {});
    runs.updateStatus(id, status);
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - ageDays * 86_400_000).toISOString(),
      id,
    );
  };
  const addEvent = (runId: string, type: string, payload: Record<string, unknown> = {}) =>
    events.append({
      id: `e-${Math.random()}`,
      runId,
      type: type as never,
      payload,
      timestamp: new Date(),
    });
  const addTokens = (runId: string, tokens: number, usd: number) => {
    const taskId = `T-${runId}`;
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(
      taskId,
      runId,
      't',
      't',
      'implementation',
      'integrated',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    costs.record({
      id: `c-${Math.random()}`,
      runId,
      taskId,
      agentId: 'a',
      modelName: 'm',
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: tokens,
      usageSource: 'provider_reported',
      plannedEstimatedTokens: 0,
      estimatedCostUsd: usd,
    });
  };
  return { db, addRun, addEvent, addTokens };
}

describe('computeInsights', () => {
  it('summarises outcomes, stop causes, resumes, undos and cost from local history', () => {
    const { db, addRun, addEvent, addTokens } = setup();
    addRun('run-a', 'completed');
    addRun('run-b', 'completed');
    addRun('run-c', 'failed');
    addRun('run-d', 'abandoned');
    addRun('run-e', 'running');
    addRun('run-old', 'failed', 90); // outside the window
    addEvent('run-c', 'TASK_RECOVERY_BLOCKED', { failureClass: 'verification_configuration' });
    addEvent('run-d', 'TASK_RECOVERY_BLOCKED', { failureClass: 'verification_configuration' });
    addEvent('run-d', 'TOKEN_BUDGET_REACHED', { spent: 1, budget: 1 });
    addEvent('run-c', 'RUN_RESUMED');
    addEvent('run-a', 'DELIVERY_REVERTED');
    addTokens('run-a', 1000, 0.5);
    addTokens('run-b', 3000, 1.5);

    const report = computeInsights(db, { sinceDays: 30 });

    expect(report.runs).toBe(5);
    expect(report.byStatus).toMatchObject({ completed: 2, failed: 1, abandoned: 1, running: 1 });
    expect(report.completionRate).toBeCloseTo(0.5); // 2 of the 4 that ended
    expect(report.resumedRuns).toBe(1);
    expect(report.undoneRuns).toBe(1);
    expect(report.stopCauses[0]).toMatchObject({ cause: 'verification_configuration', count: 2 });
    expect(report.stopCauses.map((c) => c.cause)).toContain('token_budget');
    expect(report.tokens).toMatchObject({ total: 4000, averagePerRun: 2000, runsWithUsage: 2 });
    expect(report.costUsd.total).toBeCloseTo(2);
    db.close();
  });

  it('reads well, says when there is nothing, and never claims data was sent', () => {
    const { db, addRun } = setup();
    expect(formatInsights(computeInsights(db)).join('\n')).toContain('No runs in the last 30 days');
    addRun('run-x', 'failed');
    const text = formatInsights(computeInsights(db)).join('\n');
    expect(text).toContain('no usage was reported');
    expect(text).toContain('nothing is sent anywhere');
    db.close();
  });

  describe('agents and parallel work', () => {
    const T0 = Date.parse('2026-01-01T10:00:00Z');
    const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

    function addExecution(
      db: TaskForgeDatabase,
      runId: string,
      n: string,
      taskId: string,
      agentId: string,
      start: number,
      end: number | undefined,
      status: string,
    ) {
      const now = new Date().toISOString();
      if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) {
        db.prepare(
          'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
        ).run(taskId, runId, 't', 't', 'implementation', 'integrated', now, now);
      }
      db.prepare(
        'INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(`as-${n}`, taskId, runId, agentId, 'implementer', 'o', 'completed', now, now);
      db.prepare(
        'INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        `ex-${n}`,
        runId,
        taskId,
        `as-${n}`,
        agentId,
        at(start),
        end === undefined ? null : at(end),
        status,
      );
    }

    it('reports how each agent did, with success, time and tokens', () => {
      const { db, addRun } = setup();
      addRun('run-1', 'completed');
      addExecution(db, 'run-1', '1', 'T1', 'codex', 0, 100, 'success');
      addExecution(db, 'run-1', '2', 'T2', 'agy', 0, 300, 'failed');
      addExecution(db, 'run-1', '3', 'T2', 'claude', 300, 500, 'success');
      addExecution(db, 'run-1', '4', 'T3', 'codex', 500, undefined, 'running'); // not finished: not counted

      const report = computeInsights(db, { sinceDays: 3650 });

      const byId = Object.fromEntries(report.agents.map((a) => [a.agentId, a]));
      expect(byId.codex).toMatchObject({
        executions: 1,
        succeeded: 1,
        failed: 0,
        averageSeconds: 100,
      });
      expect(byId.agy).toMatchObject({
        executions: 1,
        succeeded: 0,
        failed: 1,
        averageSeconds: 300,
      });
      expect(byId.claude).toMatchObject({ executions: 1, succeeded: 1, averageSeconds: 200 });
      expect(formatInsights(report).join('\n')).toContain('agy: 0/1 succeeded');
      db.close();
    });

    it('measures overlap between tasks: 2.00x when two equal tasks run together, 1.00x when in turn', () => {
      const together = setup();
      together.addRun('r', 'completed');
      addExecution(together.db, 'r', 'a', 'A1', 'codex', 0, 100, 'success');
      addExecution(together.db, 'r', 'b', 'A2', 'claude', 0, 100, 'success');
      expect(computeInsights(together.db, { sinceDays: 3650 }).parallelism).toEqual({
        factor: 2,
        runs: 1,
      });
      together.db.close();

      const inTurn = setup();
      inTurn.addRun('r', 'completed');
      addExecution(inTurn.db, 'r', 'c', 'B1', 'codex', 0, 100, 'success');
      addExecution(inTurn.db, 'r', 'd', 'B2', 'codex', 100, 200, 'success');
      expect(computeInsights(inTurn.db, { sinceDays: 3650 }).parallelism).toEqual({
        factor: 1,
        runs: 1,
      });
      inTurn.db.close();
    });

    it('counts agents working together on one task once, so redundancy is not parallel work', () => {
      const { db, addRun } = setup();
      addRun('team', 'completed');
      addExecution(db, 'team', 'a', 'T1', 'codex', 0, 100, 'success');
      addExecution(db, 'team', 'b', 'T1', 'claude', 0, 100, 'success'); // same task, same time
      addExecution(db, 'team', 'c', 'T2', 'codex', 100, 200, 'success');

      expect(computeInsights(db, { sinceDays: 3650 }).parallelism!.factor).toBe(1);
      db.close();
    });

    it('leaves parallelism out for a run of a single task', () => {
      const { db, addRun } = setup();
      addRun('solo', 'completed');
      addExecution(db, 'solo', 'a', 'T1', 'codex', 0, 100, 'success');
      expect(computeInsights(db, { sinceDays: 3650 }).parallelism).toBeUndefined();
      db.close();
    });
  });

  describe('where the time went', () => {
    const T0 = Date.parse('2026-01-01T10:00:00Z');
    const at = (seconds: number) => new Date(T0 + seconds * 1000);

    /** A finished run from second 0 to `end`, with agents, checks and events placed on a timeline. */
    function timeline(
      end: number,
      agents: Array<[task: string, agent: string, start: number, finish: number]>,
      checks: Array<[task: string, start: number, finish: number]> = [],
    ) {
      const { db, addRun } = setup();
      addRun('run-t', 'completed');
      db.prepare('UPDATE runs SET created_at = ?, completed_at = ? WHERE id = ?').run(
        at(0).toISOString(),
        at(end).toISOString(),
        'run-t',
      );
      const now = new Date().toISOString();
      const events = new EventRepository(db);
      agents.forEach(([task, agent, start, finish], n) => {
        if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(task)) {
          db.prepare(
            'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
          ).run(task, 'run-t', 't', 't', 'implementation', 'integrated', now, now);
        }
        db.prepare(
          'INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(`as-${n}`, task, 'run-t', agent, 'implementer', 'o', 'completed', now, now);
        db.prepare(
          'INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          `ex-${n}`,
          'run-t',
          task,
          `as-${n}`,
          agent,
          at(start).toISOString(),
          at(finish).toISOString(),
          'success',
        );
      });
      for (const [task, start, finish] of checks) {
        events.append({
          id: `v1-${task}-${start}`,
          runId: 'run-t',
          taskId: task,
          type: 'VERIFY_STARTED' as never,
          payload: {},
          timestamp: at(start),
        });
        events.append({
          id: `v2-${task}-${start}`,
          runId: 'run-t',
          taskId: task,
          type: 'VERIFY_COMPLETED' as never,
          payload: {},
          timestamp: at(finish),
        });
      }
      return { db, time: computeInsights(db, { sinceDays: 3650 }).time };
    }

    it("splits one run into agents, checks and TaskForge's own steps, and says what is before and after the agents", () => {
      // 0-10 setup, 10-70 agent, 70-80 checks, 80-100 integrating and wrap-up
      const { db, time } = timeline(100, [['T1', 'codex', 10, 70]], [['T1', 70, 80]]);
      expect(time).toMatchObject({
        runs: 1,
        totalSeconds: 100,
        agentSeconds: 60,
        verificationSeconds: 10,
        otherSeconds: 30,
        averageSecondsBeforeFirstAgent: 10,
        averageSecondsAfterLastAgent: 30,
      });
      db.close();
    });

    it('counts agents that overlap once, and a check that runs while another agent works as agent time', () => {
      // two agents 10-60 and 30-80 (union 70 s); a check 70-90 overlaps agent work until 80 (10 s left)
      const { db, time } = timeline(
        100,
        [
          ['T1', 'codex', 10, 60],
          ['T2', 'claude', 30, 80],
        ],
        [['T1', 70, 90]],
      );
      expect(time).toMatchObject({ agentSeconds: 70, verificationSeconds: 10, otherSeconds: 20 });
      db.close();
    });

    it('does not report time for a run with no real agent, or one that has not ended', () => {
      expect(timeline(100, [['T1', 'fake-agent', 10, 50]]).time).toBeUndefined();

      const { db, addRun } = setup();
      addRun('running', 'running');
      expect(computeInsights(db, { sinceDays: 3650 }).time).toBeUndefined();
      db.close();
    });

    it('reads in plain words, and says planning is not part of it', () => {
      const { db } = timeline(100, [['T1', 'codex', 10, 70]], [['T1', 70, 80]]);
      const text = formatInsights(computeInsights(db, { sinceDays: 3650 })).join('\n');
      expect(text).toContain("agents working 60%, checks 10%, TaskForge's own steps 30%");
      expect(text).toContain('before the first agent starts: 10s');
      expect(text).toContain('planning happens before the run');
      db.close();
    });
  });
});
