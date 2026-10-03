import { describe, it, expect } from 'vitest';
import { TaskForgeDatabase, RunRepository } from '@taskforge/persistence';
import { TelemetryCollector } from '../src/telemetry-collector.js';

describe('observed tokens per assignment', () => {
  function seed(totals: number[]) {
    const db = new TaskForgeDatabase(':memory:');
    new RunRepository(db).create('run-1', undefined, {});
    const telemetry = new TelemetryCollector(db);
    totals.forEach((total, i) => {
      db.prepare(
        'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      ).run(`T${i}`, 'run-1', 't', 't', 'implementation', 'integrated', new Date().toISOString(), new Date().toISOString());
      telemetry.recordTaskTokens({
        runId: 'run-1',
        taskId: `T${i}`,
        assignmentId: `asgn-${i}`,
        agentId: 'a',
        modelName: 'm',
        inputTokens: total,
        outputTokens: 0,
      });
    });
    return { db, telemetry };
  }

  it('says nothing with too few samples, and otherwise gives the average and a high value', () => {
    const few = seed([100, 200]);
    expect(few.telemetry.observedAssignmentTokens()).toBeUndefined();
    few.db.close();

    const many = seed([100_000, 200_000, 300_000, 400_000, 1_000_000]);
    const observed = many.telemetry.observedAssignmentTokens()!;
    expect(observed.samples).toBe(5);
    expect(observed.average).toBe(400_000);
    expect(observed.high).toBe(1_000_000);
    many.db.close();
  });
});
