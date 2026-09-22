import { describe, expect, it } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { TelemetryCollector } from '../src/telemetry-collector.js';
import { UsageCalibrationEngine } from '../src/usage-calibration.js';

function seedTask(
  db: TaskForgeDatabase,
  runId: string,
  taskId: string,
  type: string,
  assignmentId: string,
): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO runs (id, status, created_at) VALUES (?, 'completed', ?)").run(
    runId,
    now,
  );
  db.prepare(
    "INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, 'Usage task', 'Usage task', ?, 'completed', 0, ?, ?)",
  ).run(taskId, runId, type, now, now);
  db.prepare(
    "INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at) VALUES (?, ?, ?, 'claude', 'implementer', 'Implement', 'completed', ?, ?)",
  ).run(assignmentId, taskId, runId, now, now);
}

describe('observed usage telemetry and calibration', () => {
  it('persists provider-reported usage and compares it with the assignment baseline', () => {
    const db = new TaskForgeDatabase(':memory:');
    seedTask(db, 'run-1', 'TASK-1', 'implementation', 'ASGN-1');

    const telemetry = new TelemetryCollector(db);
    telemetry.recordTaskTokens({
      runId: 'run-1',
      taskId: 'TASK-1',
      assignmentId: 'ASGN-1',
      agentId: 'claude',
      role: 'implementer',
      modelName: 'claude-test',
      inputTokens: 8000,
      cachedInputTokens: 2000,
      outputTokens: 2000,
      totalTokens: 12000,
      usageSource: 'provider_reported',
      plannedEstimatedTokens: 10000,
    });

    const report = telemetry.getCostReport('run-1');
    expect(report.totalTokens).toBe(12000);
    expect(report.totalCachedInputTokens).toBe(2000);
    expect(report.totalPlannedEstimatedTokens).toBe(10000);

    const accuracy = telemetry.getUsageAccuracy('run-1');
    expect(accuracy.observedAssignments).toBe(1);
    expect(accuracy.observedTokens).toBe(12000);
    expect(accuracy.plannedEstimatedTokens).toBe(10000);
    expect(accuracy.varianceRatio).toBe(1.2);

    const formatted = telemetry.formatCostReport('run-1');
    expect(formatted).toContain('Observed tokens: 12,000 total');
    expect(formatted).toContain('Observed vs assignment baseline: 12,000 / 10,000 tokens');

    db.close();
  });

  it('learns a robust task-type calibration from provider-reported history', () => {
    const db = new TaskForgeDatabase(':memory:');
    const telemetry = new TelemetryCollector(db);

    const ratios = [0.8, 1.0, 1.2, 1.4];
    for (let i = 0; i < ratios.length; i++) {
      const runId = 'run-' + i;
      const taskId = 'TASK-' + i;
      const assignmentId = 'ASGN-' + i;
      seedTask(db, runId, taskId, 'implementation', assignmentId);

      const baseline = 10000;
      const observed = Math.round(baseline * ratios[i]);
      telemetry.recordTaskTokens({
        runId,
        taskId,
        assignmentId,
        agentId: 'claude',
        role: 'implementer',
        modelName: 'claude-test',
        inputTokens: observed - 1000,
        outputTokens: 1000,
        totalTokens: observed,
        usageSource: 'provider_reported',
        plannedEstimatedTokens: baseline,
      });
    }

    const calibration = new UsageCalibrationEngine(db).getCalibration({
      taskType: 'implementation',
    });

    expect(calibration.sampleSize).toBe(4);
    expect(calibration.confidence).toBe('medium');
    expect(calibration.medianRatio).toBeCloseTo(1.1, 5);
    expect(calibration.p25Ratio).toBeLessThan(calibration.medianRatio);
    expect(calibration.p75Ratio).toBeGreaterThan(calibration.medianRatio);

    db.close();
  });

  it('ignores rows that are not provider-reported or have no baseline', () => {
    const db = new TaskForgeDatabase(':memory:');
    seedTask(db, 'run-x', 'TASK-X', 'review', 'ASGN-X');

    const telemetry = new TelemetryCollector(db);
    telemetry.recordTaskTokens({
      runId: 'run-x',
      taskId: 'TASK-X',
      assignmentId: 'ASGN-X',
      agentId: 'codex',
      role: 'reviewer',
      modelName: 'codex',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      usageSource: 'taskforge_estimated',
      plannedEstimatedTokens: 1000,
    });

    const calibration = new UsageCalibrationEngine(db).getCalibration({
      taskType: 'review',
    });

    expect(calibration.sampleSize).toBe(0);
    expect(calibration.confidence).toBe('low');

    db.close();
  });
});
