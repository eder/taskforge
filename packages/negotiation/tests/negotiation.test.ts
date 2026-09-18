import { describe, it, expect } from 'vitest';
import { NegotiationManager, PreflightEvaluator } from '../src/negotiator.js';
import { Task, TaskGraph } from '@taskforge/core';
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { TaskPreflightResult } from '@taskforge/shared';

describe('NegotiationManager', () => {
  it('handles worker accepting a task cleanly', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const goalRepo = new (await import('@taskforge/persistence')).GoalRepository(db);
    const runRepo = new (await import('@taskforge/persistence')).RunRepository(db);
    const taskRepo = new (await import('@taskforge/persistence')).TaskRepository(db);

    goalRepo.create({ id: 'goal-1', description: 'Goal 1', repository: '/tmp' });
    runRepo.create('run-1', 'goal-1');

    const negotiator = new NegotiationManager(undefined, eventRepo, db);

    const task: Task = {
      id: 'TASK-1',
      goalId: 'goal-1',
      title: 'Simple task',
      description: 'Implement feature',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Implement feature',
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

    taskRepo.create({
      id: task.id,
      runId: 'run-1',
      goalId: 'goal-1',
      title: task.title,
      description: task.description,
      type: task.type,
      status: task.status,
      contract: task.contract,
    });

    const graph = new TaskGraph([task]);
    const negotiated = await negotiator.negotiateGraph(graph, 'run-1');

    expect(negotiated.getTask('TASK-1')?.status).toBe('accepted');
    const events = eventRepo.listByRun('run-1');
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('TASK_PREFLIGHT_STARTED');
    expect(eventTypes).toContain('TASK_ACCEPTED');

    const dbResults = db.prepare('SELECT * FROM preflight_results WHERE task_id = ?').all('TASK-1');
    expect(dbResults.length).toBe(1);
    expect((dbResults[0] as { decision: string }).decision).toBe('accept');

    db.close();
  });

  it('handles worker challenge with suggested dependencies and scope concerns', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);

    class ChallengingEvaluator implements PreflightEvaluator {
      async evaluate(task: Task): Promise<TaskPreflightResult> {
        if (task.id === 'TASK-2') {
          return {
            decision: 'challenge',
            understanding: 'Requires database schema migration first',
            concerns: ['Do not edit production migration files'],
            missingContext: ['DB connection info'],
            suggestedDependencies: ['TASK-1'],
          };
        }
        return {
          decision: 'accept',
          understanding: 'Ready',
          concerns: [],
          missingContext: [],
          suggestedDependencies: [],
        };
      }
    }

    const goalRepo = new (await import('@taskforge/persistence')).GoalRepository(db);
    const runRepo = new (await import('@taskforge/persistence')).RunRepository(db);
    const taskRepo = new (await import('@taskforge/persistence')).TaskRepository(db);

    goalRepo.create({ id: 'goal-2', description: 'Goal 2', repository: '/tmp' });
    runRepo.create('run-2', 'goal-2');

    const negotiator = new NegotiationManager(new ChallengingEvaluator(), eventRepo, db);

    const task1: Task = {
      id: 'TASK-1',
      goalId: 'goal-2',
      title: 'Schema migration',
      description: 'Create DB schema',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'DB schema',
        allowedScope: ['db/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Migrates'],
        dependencies: [],
      },
      acceptanceCriteria: ['Migrates'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const task2: Task = {
      id: 'TASK-2',
      goalId: 'goal-2',
      title: 'API endpoint',
      description: 'Build endpoint using DB schema',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'API endpoint',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Endpoint responds'],
        dependencies: [],
      },
      acceptanceCriteria: ['Endpoint responds'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    taskRepo.create({
      id: task1.id,
      runId: 'run-2',
      goalId: 'goal-2',
      title: task1.title,
      description: task1.description,
      type: task1.type,
      status: task1.status,
      contract: task1.contract,
    });

    taskRepo.create({
      id: task2.id,
      runId: 'run-2',
      goalId: 'goal-2',
      title: task2.title,
      description: task2.description,
      type: task2.type,
      status: task2.status,
      contract: task2.contract,
    });

    const graph = new TaskGraph([task1, task2]);
    const negotiated = await negotiator.negotiateGraph(graph, 'run-2');

    const updatedTask2 = negotiated.getTask('TASK-2')!;
    expect(updatedTask2.status).toBe('accepted');
    expect(updatedTask2.dependencies).toContain('TASK-1');
    expect(updatedTask2.contract.forbiddenChanges).toContain('Do not edit production migration files');

    const events = eventRepo.listByRun('run-2');
    const task2Events = events.filter((e) => e.taskId === 'TASK-2');
    expect(task2Events.some((e) => e.type === 'TASK_CHALLENGED')).toBe(true);
    expect(task2Events.some((e) => e.type === 'TASK_ACCEPTED')).toBe(true);

    db.close();
  });
});
