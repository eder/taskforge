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

    it('classifies a clean single-agent first-pass run as RIGHT-SIZED', () => {
      const collector = new TelemetryCollector(db);
      const runId = 'run-right-sized';
      const started = '2026-09-22T12:00:00.000Z';
      const finished = '2026-09-22T12:00:10.000Z';

      db.prepare(`INSERT INTO runs (id, status, created_at, completed_at) VALUES (?, 'completed', ?, ?)`)
        .run(runId, started, finished);
      db.prepare(
        `INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at)
         VALUES ('TASK-01', ?, 'Overview', 'Explain repo', 'investigation', 'integrated', 0, ?, ?)`,
      ).run(runId, started, finished);
      db.prepare(
        `INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at)
         VALUES ('ASGN-01', 'TASK-01', ?, 'codex', 'researcher', 'Explain repo', 'completed', ?, ?)`,
      ).run(runId, started, finished);
      db.prepare(
        `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
         VALUES ('EXEC-01', ?, 'TASK-01', 'ASGN-01', 'codex', ?, ?, 0, 'success')`,
      ).run(runId, started, finished);

      collector.recordTaskTokens({
        runId,
        taskId: 'TASK-01',
        assignmentId: 'ASGN-01',
        agentId: 'codex',
        role: 'researcher',
        modelName: 'gpt-codex-test',
        inputTokens: 10_000,
        outputTokens: 500,
        totalTokens: 10_500,
        plannedEstimatedTokens: 9_000,
      });

      const report = collector.getOrchestrationEfficiency(runId);
      expect(report.outcome).toBe('right_sized');
      expect(report.assignmentCount).toBe(1);
      expect(report.usefulAssignments).toBe(1);
      expect(report.wastedAssignments).toBe(0);
      expect(report.multiAgent).toBe(false);
      expect(report.firstPassRate).toBe(1);
      expect(report.tokenEfficiency).toBe('healthy');
      expect(report.qualityHealth).toBe('healthy');
      expect(report.recoveryHealth).toBe('healthy');
      expect(report.overallHealth).toBe('excellent');
    });

    it('keeps a cache-heavy successful run EXCELLENT when fresh work matches the baseline', () => {
      const collector = new TelemetryCollector(db);
      const runId = 'run-cache-heavy';
      const started = '2026-09-22T12:00:00.000Z';
      const finished = '2026-09-22T12:00:30.000Z';

      db.prepare(`INSERT INTO runs (id, status, created_at, completed_at) VALUES (?, 'completed', ?, ?)`)
        .run(runId, started, finished);
      db.prepare(
        `INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at)
         VALUES ('TASK-01', ?, 'Overview', 'Explain repo', 'investigation', 'integrated', 0, ?, ?)`,
      ).run(runId, started, finished);
      db.prepare(
        `INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at)
         VALUES ('ASGN-01', 'TASK-01', ?, 'codex', 'researcher', 'Explain repo', 'completed', ?, ?)`,
      ).run(runId, started, finished);
      db.prepare(
        `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
         VALUES ('EXEC-01', ?, 'TASK-01', 'ASGN-01', 'codex', ?, ?, 0, 'success')`,
      ).run(runId, started, finished);

      collector.recordTaskTokens({
        runId,
        taskId: 'TASK-01',
        assignmentId: 'ASGN-01',
        agentId: 'codex',
        role: 'researcher',
        modelName: 'gpt-codex-test',
        inputTokens: 200_000,
        cachedInputTokens: 195_000,
        outputTokens: 2_000,
        plannedEstimatedTokens: 7_000,
      });

      const report = collector.getOrchestrationEfficiency(runId);
      expect(report.providerReportedTokens).toBe(202_000);
      expect(report.freshWorkTokens).toBe(7_000);
      expect(report.cacheHitRatio).toBeCloseTo(0.975);
      expect(report.tokenVarianceRatio).toBeGreaterThan(20);
      expect(report.freshWorkVarianceRatio).toBe(1);
      expect(report.tokenComparisonConfidence).toBe('low');
      expect(report.tokenEfficiency).toBe('healthy');
      expect(report.overallHealth).toBe('excellent');

      const cost = collector.getCostReport(runId);
      expect(cost.totalTokens).toBe(202_000);
      expect(cost.totalInputTokens).toBe(200_000);
      expect(cost.totalCachedInputTokens).toBe(195_000);

      const formatted = collector.formatCostReport(runId);
      expect(formatted).toContain('Provider footprint: 202,000 total');
      expect(formatted).toContain('Fresh-work tokens: 7,000');
      expect(formatted).toContain('context-sensitive, not a direct efficiency ratio');
    });

    it('marks a first-pass run as NEEDS ATTENTION when fresh token work is genuinely excessive', () => {
      const collector = new TelemetryCollector(db);
      const runId = 'run-fresh-token-heavy';
      const started = '2026-09-22T12:00:00.000Z';
      const finished = '2026-09-22T12:00:30.000Z';

      db.prepare(`INSERT INTO runs (id, status, created_at, completed_at) VALUES (?, 'completed', ?, ?)`)
        .run(runId, started, finished);
      db.prepare(
        `INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at)
         VALUES ('TASK-01', ?, 'Overview', 'Explain repo', 'investigation', 'integrated', 0, ?, ?)`,
      ).run(runId, started, finished);
      db.prepare(
        `INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at)
         VALUES ('ASGN-01', 'TASK-01', ?, 'codex', 'researcher', 'Explain repo', 'completed', ?, ?)`,
      ).run(runId, started, finished);
      db.prepare(
        `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
         VALUES ('EXEC-01', ?, 'TASK-01', 'ASGN-01', 'codex', ?, ?, 0, 'success')`,
      ).run(runId, started, finished);

      collector.recordTaskTokens({
        runId,
        taskId: 'TASK-01',
        assignmentId: 'ASGN-01',
        agentId: 'codex',
        role: 'researcher',
        modelName: 'gpt-codex-test',
        inputTokens: 45_000,
        cachedInputTokens: 2_000,
        outputTokens: 4_000,
        plannedEstimatedTokens: 7_000,
      });

      const report = collector.getOrchestrationEfficiency(runId);
      expect(report.freshWorkTokens).toBe(47_000);
      expect(report.freshWorkVarianceRatio).toBeGreaterThan(6);
      expect(report.tokenEfficiency).toBe('attention');
      expect(report.overallHealth).toBe('needs_attention');
    });

    it('classifies real parallel specialist work as FAN-OUT JUSTIFIED', () => {
      const collector = new TelemetryCollector(db);
      const runId = 'run-justified-fanout';
      const base = '2026-09-22T12:00:00.000Z';

      db.prepare(`INSERT INTO runs (id, status, created_at, completed_at) VALUES (?, 'completed', ?, ?)`)
        .run(runId, base, '2026-09-22T12:00:12.000Z');

      for (const [taskId, role, agent] of [
        ['TASK-A', 'implementer', 'codex'],
        ['TASK-B', 'architecture_reviewer', 'claude'],
      ] as const) {
        db.prepare(
          `INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at)
           VALUES (?, ?, 'Task', 'Desc', 'implementation', 'integrated', 0, ?, ?)`,
        ).run(taskId, runId, base, '2026-09-22T12:00:12.000Z');
        db.prepare(
          `INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'Distinct objective', 'completed', ?, ?)`,
        ).run(`ASGN-${taskId}`, taskId, runId, agent, role, base, '2026-09-22T12:00:12.000Z');
      }

      db.prepare(
        `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
         VALUES ('EXEC-A', ?, 'TASK-A', 'ASGN-TASK-A', 'codex', ?, ?, 0, 'success')`,
      ).run(runId, '2026-09-22T12:00:00.000Z', '2026-09-22T12:00:10.000Z');
      db.prepare(
        `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
         VALUES ('EXEC-B', ?, 'TASK-B', 'ASGN-TASK-B', 'claude', ?, ?, 0, 'success')`,
      ).run(runId, '2026-09-22T12:00:02.000Z', '2026-09-22T12:00:12.000Z');

      db.prepare(
        `INSERT INTO events (id, run_id, task_id, type, payload_json, timestamp)
         VALUES ('EVT-ROUTE', ?, 'TASK-A', 'ROUTING_DECIDED', ?, ?)`,
      ).run(
        runId,
        JSON.stringify({
          strategy: 'parallel',
          teamSize: 2,
          fanOutAssessment: {
            requested: true,
            admitted: true,
            requestedTeamSize: 2,
            admittedTeamSize: 2,
            benefits: ['parallel_work'],
            reasons: ['distinct work'],
          },
        }),
        '2026-09-22T12:00:00.000Z',
      );

      for (const [taskId, assignmentId, agentId, role] of [
        ['TASK-A', 'ASGN-TASK-A', 'codex', 'implementer'],
        ['TASK-B', 'ASGN-TASK-B', 'claude', 'architecture_reviewer'],
      ]) {
        collector.recordTaskTokens({
          runId,
          taskId,
          assignmentId,
          agentId,
          role,
          modelName: agentId,
          inputTokens: 10_000,
          outputTokens: 1_000,
          totalTokens: 11_000,
          plannedEstimatedTokens: 10_000,
        });
      }

      const report = collector.getOrchestrationEfficiency(runId);
      expect(report.outcome).toBe('fan_out_justified');
      expect(report.multiAgent).toBe(true);
      expect(report.timeBenefitObserved).toBe(true);
      expect(report.qualityGuardSignalObserved).toBe(true);
      expect(report.observedParallelOverlapMs).toBe(8_000);
      expect(report.parallelismFactor).toBeGreaterThan(1.5);
      expect(report.wastedAssignments).toBe(0);
      expect(report.fanOutDecisions).toBe(1);
      expect(report.admittedFanOutDecisions).toBe(1);
      expect(report.rejectedFanOutDecisions).toBe(0);
    });

    it('classifies false failover with wasted provider tokens as INEFFICIENT', () => {
      const collector = new TelemetryCollector(db);
      const runId = 'run-false-failover';
      const created = '2026-09-22T12:00:00.000Z';

      db.prepare(`INSERT INTO runs (id, status, created_at, completed_at) VALUES (?, 'completed', ?, ?)`)
        .run(runId, created, '2026-09-22T12:00:30.000Z');
      db.prepare(
        `INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at)
         VALUES ('TASK-01', ?, 'Overview', 'Explain repo', 'investigation', 'integrated', 1, ?, ?)`,
      ).run(runId, created, '2026-09-22T12:00:30.000Z');

      db.prepare(
        `INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, completion_reason, created_at, updated_at)
         VALUES ('ASGN-CODEX', 'TASK-01', ?, 'codex', 'researcher', 'Explain repo', 'failed', 'EMPTY_PROVIDER_RESULT', ?, ?)`,
      ).run(runId, created, '2026-09-22T12:00:20.000Z');
      db.prepare(
        `INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at)
         VALUES ('ASGN-CLAUDE', 'TASK-01', ?, 'claude', 'researcher', 'Explain repo', 'completed', ?, ?)`,
      ).run(runId, '2026-09-22T12:00:20.000Z', '2026-09-22T12:00:30.000Z');

      db.prepare(
        `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
         VALUES ('EXEC-CODEX', ?, 'TASK-01', 'ASGN-CODEX', 'codex', ?, ?, 0, 'success')`,
      ).run(runId, created, '2026-09-22T12:00:20.000Z');
      db.prepare(
        `INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, started_at, finished_at, exit_code, status)
         VALUES ('EXEC-CLAUDE', ?, 'TASK-01', 'ASGN-CLAUDE', 'claude', ?, ?, 0, 'success')`,
      ).run(runId, '2026-09-22T12:00:20.000Z', '2026-09-22T12:00:30.000Z');

      db.prepare(
        `INSERT INTO events (id, run_id, task_id, type, payload_json, timestamp)
         VALUES ('EVT-REJECT', ?, 'TASK-01', 'COMPLETION_GATE_REJECTED', ?, ?)`,
      ).run(runId, JSON.stringify({ failureReason: 'EMPTY_PROVIDER_RESULT' }), '2026-09-22T12:00:20.000Z');

      collector.recordTaskTokens({
        runId,
        taskId: 'TASK-01',
        assignmentId: 'ASGN-CODEX',
        agentId: 'codex',
        role: 'researcher',
        modelName: 'codex',
        inputTokens: 390_000,
        outputTokens: 10_000,
        totalTokens: 400_000,
        plannedEstimatedTokens: 7_000,
      });
      collector.recordTaskTokens({
        runId,
        taskId: 'TASK-01',
        assignmentId: 'ASGN-CLAUDE',
        agentId: 'claude',
        role: 'researcher',
        modelName: 'claude',
        inputTokens: 55_000,
        outputTokens: 3_000,
        totalTokens: 58_000,
        plannedEstimatedTokens: 7_000,
      });

      const report = collector.getOrchestrationEfficiency(runId);
      expect(report.outcome).toBe('inefficient');
      expect(report.retryOrFailoverAssignments).toBe(1);
      expect(report.wastedAssignments).toBe(1);
      expect(report.wastedProviderTokens).toBe(400_000);
      expect(report.wastedTokenRatio).toBeGreaterThan(0.8);
      expect(report.completionGateRejections).toBe(1);
      expect(report.reworkCount).toBe(1);
      expect(report.recoveryHealth).toBe('attention');
      expect(report.overallHealth).toBe('inefficient');

      const formatted = collector.formatOrchestrationEfficiencyReport(runId);
      expect(formatted).toContain('Overall: INEFFICIENT');
      expect(formatted).toContain('Staffing: INEFFICIENT');
      expect(formatted).toContain('Wasted provider tokens: 400,000');
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
