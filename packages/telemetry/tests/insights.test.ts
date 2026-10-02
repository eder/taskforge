import { describe, it, expect } from 'vitest';
import { TaskForgeDatabase, RunRepository, EventRepository, CostRepository } from '@taskforge/persistence';
import { computeInsights, formatInsights } from '../src/insights.js';

function setup() {
  const db = new TaskForgeDatabase(':memory:');
  const runs = new RunRepository(db);
  const events = new EventRepository(db);
  const costs = new CostRepository(db);
  const addRun = (id: string, status: string, ageDays = 1) => {
    runs.create(id, undefined, {});
    runs.updateStatus(id, status);
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - ageDays * 86_400_000).toISOString(), id);
  };
  const addEvent = (runId: string, type: string, payload: Record<string, unknown> = {}) =>
    events.append({ id: `e-${Math.random()}`, runId, type: type as never, payload, timestamp: new Date() });
  const addTokens = (runId: string, tokens: number, usd: number) => {
    const taskId = `T-${runId}`;
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(taskId, runId, 't', 't', 'implementation', 'integrated', new Date().toISOString(), new Date().toISOString());
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
});
