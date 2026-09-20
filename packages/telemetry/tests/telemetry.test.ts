import { describe, it, expect, beforeEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { CostEstimator, TelemetryCollector, PerformanceEngine } from '../src/index.js';

describe('Phases 17 & 18: Telemetry, Stats & Performance Engine', () => {
  let db: TaskForgeDatabase;

  beforeEach(() => {
    db = new TaskForgeDatabase(':memory:');
  });

  describe('CostEstimator', () => {
    it('estimates costs correctly based on model pricing', () => {
      // 1M input + 1M output on Claude 3.7 Sonnet ($3 / $15)
      const cost = CostEstimator.estimateCost('claude-3-7-sonnet', 1_000_000, 1_000_000);
      expect(cost).toBe(18.0);

      // 500k input + 200k output on GPT-4o ($2.50 / $10)
      const gptCost = CostEstimator.estimateCost('gpt-4o', 500_000, 200_000);
      expect(gptCost).toBe(3.25);

      // Gemini Flash ($0.10 / $0.40 per M)
      const flashCost = CostEstimator.estimateCost('gemini-2.0-flash', 100_000, 50_000);
      expect(flashCost).toBe(0.03);
    });
  });

  describe('TelemetryCollector', () => {
    it('records tokens, stores costs, and generates reports', () => {
      const collector = new TelemetryCollector(db);
      const runId = 'run-cost-test';

      // Insert dummy task in DB for foreign key constraint
      db.prepare(`INSERT INTO runs (id, status, created_at) VALUES (?, 'running', ?)`).run(
        runId,
        new Date().toISOString(),
      );

      db.prepare(
        `INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at)
         VALUES ('TASK-01', ?, 'Task 1', 'Desc', 'implementation', 'completed', 0, ?, ?)`,
      ).run(runId, new Date().toISOString(), new Date().toISOString());

      collector.recordTaskTokens({
        runId,
        taskId: 'TASK-01',
        agentId: 'claude',
        modelName: 'claude-3-7-sonnet',
        inputTokens: 10_000,
        outputTokens: 2_000,
      });

      const report = collector.getCostReport(runId);
      expect(report.totalCostUsd).toBeGreaterThan(0);
      expect(report.totalInputTokens).toBe(10_000);
      expect(report.totalOutputTokens).toBe(2_000);
      expect(report.breakdown).toHaveLength(1);

      const formatted = collector.formatCostReport(runId);
      expect(formatted).toContain('Cost Report');
      expect(formatted).toContain('TASK-01');

      // Record run metrics
      collector.recordRunMetrics({
        runId,
        durationMs: 4500,
        tasksCount: 2,
        tasksCompleted: 2,
        tasksFailed: 0,
        reworkCount: 0,
        escalationsCount: 0,
      });

      const statsReport = collector.formatStatsReport(runId);
      expect(statsReport).toContain('Run Metrics - run-cost-test');
      expect(statsReport).toContain('2/2 completed');
    });

    it('extracts and surfaces staffing bottleneck metrics', () => {
      const collector = new TelemetryCollector(db);
      const runId = 'run-staffing-metrics';

      db.prepare(`INSERT INTO runs (id, status, created_at) VALUES (?, 'completed', ?)`).run(
        runId,
        new Date().toISOString(),
      );

      // Record STAFFING_CAPPED and COLLABORATION_REJECTED events
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO events (id, run_id, task_id, type, payload_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('evt-1', runId, 'TASK-1', 'STAFFING_CAPPED', JSON.stringify({ cappedTo: 2 }), now);
      db.prepare(
        `INSERT INTO events (id, run_id, task_id, type, payload_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('evt-2', runId, 'TASK-1', 'COLLABORATION_REJECTED', JSON.stringify({ reason: 'limit' }), now);
      db.prepare(
        `INSERT INTO events (id, run_id, task_id, type, payload_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('evt-3', runId, 'TASK-2', 'COLLABORATION_APPROVED', JSON.stringify({ helper: 'agentB' }), now);

      const bottlenecks = collector.getStaffingMetrics(runId);
      expect(bottlenecks.staffingCappedCount).toBe(1);
      expect(bottlenecks.collaborationRejectedCount).toBe(1);
      expect(bottlenecks.collaborationApprovedCount).toBe(1);
      expect(bottlenecks.collaborationDelayedCount).toBe(0);

      collector.recordRunMetrics({
        runId,
        durationMs: 3000,
        tasksCount: 2,
        tasksCompleted: 2,
        tasksFailed: 0,
        reworkCount: 0,
        escalationsCount: 1,
      });

      const summary = collector.getRunSummary(runId);
      expect(summary?.staffingBottlenecks?.staffingCappedCount).toBe(1);
      expect(summary?.staffingBottlenecks?.collaborationRejectedCount).toBe(1);

      const report = collector.formatStatsReport(runId);
      expect(report).toContain('Staffing bottlenecks: 1 capped, 1 rejected');
      expect(report).toContain('Collaboration approved: 1 emergent helper assignment(s)');
    });
  });

  describe('PerformanceEngine', () => {
    it('reports low confidence and uncertainty when sample size is below threshold', () => {
      const engine = new PerformanceEngine(db, { minSampleSize: 3 });

      const stats = engine.getAgentStats({
        agentId: 'unknown-agent',
        role: 'implementer',
        taskType: 'implementation',
      });

      expect(stats.sampleSize).toBe(0);
      expect(stats.confidence).toBe('low');
      expect(stats.compositeScore).toBe(0.5); // neutral fallback
    });

    it('aggregates performance metrics and computes composite score when data exists', () => {
      const engine = new PerformanceEngine(db, { minSampleSize: 3 });
      const runId = 'run-perf-test';

      db.prepare(`INSERT INTO runs (id, status, created_at) VALUES (?, 'completed', ?)`).run(
        runId,
        new Date().toISOString(),
      );

      // Create 3 successful tasks with low rework
      for (let i = 1; i <= 3; i++) {
        const taskId = `TASK-${i}`;
        const asgnId = `ASGN-${i}`;
        const now = new Date().toISOString();

        db.prepare(
          `INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at)
           VALUES (?, ?, 'Task', 'Desc', 'implementation', 'completed', 0, ?, ?)`,
        ).run(taskId, runId, now, now);

        db.prepare(
          `INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at)
           VALUES (?, ?, ?, 'codex', 'implementer', 'Code', 'completed', ?, ?)`,
        ).run(asgnId, taskId, runId, now, now);

        db.prepare(
          `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
           VALUES (?, ?, ?, ?, 'codex', ?, ?, 0, 'success')`,
        ).run(`EXEC-${i}`, runId, taskId, asgnId, now, now);
      }

      const stats = engine.getAgentStats({
        agentId: 'codex',
        role: 'implementer',
        taskType: 'implementation',
      });

      expect(stats.sampleSize).toBe(3);
      expect(stats.confidence).toBe('medium');
      expect(stats.successRate).toBe(1.0);
      expect(stats.firstPassRate).toBe(1.0);
      expect(stats.reworkRate).toBe(0);
      expect(stats.compositeScore).toBeGreaterThan(0.7);

      const formatted = engine.formatAgentReport(stats);
      expect(formatted).toContain('MEDIUM confidence');
      expect(formatted).toContain('Success Rate: 100.0%');
    });
  });
});
