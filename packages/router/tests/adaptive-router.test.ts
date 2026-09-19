import { describe, it, expect, beforeEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { PerformanceEngine } from '@taskforge/telemetry';
import {
  AdaptiveRoutingProvider,
  StaticRoutingProvider,
  RoutingInput,
} from '../src/index.js';
import { Task } from '@taskforge/core';

describe('Phase 19: Adaptive Routing Provider', () => {
  let db: TaskForgeDatabase;
  let perfEngine: PerformanceEngine;
  let staticProvider: StaticRoutingProvider;

  beforeEach(() => {
    db = new TaskForgeDatabase(':memory:');
    perfEngine = new PerformanceEngine(db, { minSampleSize: 3 });
    staticProvider = new StaticRoutingProvider();
  });

  it('falls back safely to default routing and preserves uncertainty when data is scarce', async () => {
    const adaptiveProvider = new AdaptiveRoutingProvider(perfEngine, staticProvider, {
      minConfidence: 'medium',
    });

    const task: Task = {
      id: 'TASK-1',
      goalId: 'goal-1',
      title: 'Build API Endpoint',
      description: 'API endpoint for user profiles',
      type: 'implementation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Build endpoint',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Passes'],
        dependencies: [],
      },
      acceptanceCriteria: ['Passes'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const input: RoutingInput = {
      task,
      availableAgents: ['claude', 'codex', 'agy'],
    };

    const decision = await adaptiveProvider.route(input);
    expect(decision.strategy).toBeDefined();
    expect(decision.roles.length).toBeGreaterThan(0);
    expect(decision.reason).toContain('insufficient historical data');
    expect(decision.reason).toContain('Confidence: LOW');
  });

  it('biases role assignment toward historically higher-performing agent when data is sufficient', async () => {
    // Seed 4 successful executions for 'codex' as implementer
    const runId = 'run-seed';
    db.prepare(`INSERT INTO runs (id, status, created_at) VALUES (?, 'completed', ?)`).run(
      runId,
      new Date().toISOString(),
    );

    for (let i = 1; i <= 4; i++) {
      const taskId = `SEED-${i}`;
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

    const adaptiveProvider = new AdaptiveRoutingProvider(perfEngine, staticProvider, {
      minConfidence: 'medium',
    });

    const task: Task = {
      id: 'TASK-2',
      goalId: 'goal-1',
      title: 'Implement Service',
      description: 'Implement backend service',
      type: 'implementation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Implement service',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Done'],
        dependencies: [],
      },
      acceptanceCriteria: ['Done'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const input: RoutingInput = {
      task,
      availableAgents: ['claude', 'codex', 'agy'],
    };

    const decision = await adaptiveProvider.route(input);
    const implementerRole = decision.roles.find((r) => r.role === 'implementer');

    expect(implementerRole).toBeDefined();
    expect(implementerRole?.preferredAgent).toBe('codex');
    expect(decision.reason).toContain('assigned to codex based on historical composite score');
  });
});
