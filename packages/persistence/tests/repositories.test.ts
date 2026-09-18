import { describe, it, expect, beforeEach } from 'vitest';
import { TaskForgeDatabase } from '../src/database.js';
import {
  RunRepository,
  GoalRepository,
  TaskRepository,
  AssignmentRepository,
  ExecutionRepository,
  EventRepository,
  VerificationRepository,
  AuditService,
} from '../src/repositories.js';

describe('Persistence - SQLite Repositories', () => {
  let db: TaskForgeDatabase;
  let runRepo: RunRepository;
  let goalRepo: GoalRepository;
  let taskRepo: TaskRepository;
  let assignmentRepo: AssignmentRepository;
  let executionRepo: ExecutionRepository;
  let eventRepo: EventRepository;
  let verificationRepo: VerificationRepository;
  let auditService: AuditService;

  beforeEach(() => {
    db = new TaskForgeDatabase(':memory:');
    runRepo = new RunRepository(db);
    goalRepo = new GoalRepository(db);
    taskRepo = new TaskRepository(db);
    assignmentRepo = new AssignmentRepository(db);
    executionRepo = new ExecutionRepository(db);
    eventRepo = new EventRepository(db);
    verificationRepo = new VerificationRepository(db);
    auditService = new AuditService(runRepo, goalRepo, taskRepo, eventRepo);
  });

  it('creates and retrieves a run with goal and tasks', () => {
    const goal = goalRepo.create({
      id: 'GOAL-1',
      description: 'Implement auth',
      repository: '/repo',
      constraints: [{ type: 'scope', value: 'auth/**' }],
      acceptanceCriteria: ['tests pass'],
    });

    const run = runRepo.create('run-123', goal.id, { initiatedBy: 'human' });
    expect(run.id).toBe('run-123');
    expect(run.status).toBe('running');

    const task = taskRepo.create({
      id: 'TASK-1',
      runId: run.id,
      goalId: goal.id,
      title: 'Backend auth service',
      description: 'Create login API',
      type: 'implementation',
      status: 'accepted',
      contract: {
        objective: 'Login endpoint',
        allowedScope: ['src/auth/**'],
        forbiddenChanges: ['db/schema.sql'],
        acceptanceCriteria: ['passes tests'],
        dependencies: [],
      },
    });

    expect(task.id).toBe('TASK-1');
    expect(task.status).toBe('accepted');

    taskRepo.updateStatus('TASK-1', 'running');
    const updated = taskRepo.get('TASK-1');
    expect(updated?.status).toBe('running');

    // Audit reconstruction
    const audit = auditService.reconstructRun(run.id);
    expect(audit).toBeDefined();
    expect(audit?.run.id).toBe('run-123');
    expect(audit?.goal?.id).toBe('GOAL-1');
    expect(audit?.tasks.length).toBe(1);
  });

  it('handles task dependencies and rework count', () => {
    runRepo.create('run-1');
    taskRepo.create({
      id: 'TASK-A',
      runId: 'run-1',
      title: 'Task A',
      description: 'First',
      type: 'implementation',
      status: 'verified',
    });

    taskRepo.create({
      id: 'TASK-B',
      runId: 'run-1',
      title: 'Task B',
      description: 'Second',
      type: 'implementation',
      status: 'accepted',
      dependencies: ['TASK-A'],
    });

    const taskB = taskRepo.get('TASK-B');
    expect(taskB?.dependencies).toEqual(['TASK-A']);

    const rework = taskRepo.incrementRework('TASK-B');
    expect(rework).toBe(1);
  });

  it('records process execution and events', () => {
    runRepo.create('run-1');
    taskRepo.create({
      id: 'TASK-1',
      runId: 'run-1',
      title: 'T1',
      description: 'D1',
      type: 'implementation',
      status: 'running',
    });

    const assignment = assignmentRepo.create(
      {
        id: 'ASGN-1',
        taskId: 'TASK-1',
        agentId: 'fake-agent',
        role: 'implementer',
        objective: 'Code',
        status: 'running',
      },
      'run-1',
    );

    const exec = executionRepo.create({
      id: 'EXEC-1',
      runId: 'run-1',
      taskId: 'TASK-1',
      assignmentId: assignment.id,
      agentId: 'fake-agent',
      pid: 12345,
      logPath: '/tmp/exec.log',
    });

    expect(exec.status).toBe('running');
    executionRepo.complete(exec.id, 'success', 0);

    const execs = executionRepo.listByTask('TASK-1');
    expect(execs[0].status).toBe('success');
    expect(execs[0].exitCode).toBe(0);

    // Event append and query
    eventRepo.append({
      id: 'EVT-1',
      runId: 'run-1',
      taskId: 'TASK-1',
      type: 'TASK_STARTED',
      payload: { agent: 'fake-agent' },
      timestamp: new Date(),
    });

    const events = eventRepo.listByRun('run-1');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('TASK_STARTED');
  });

  it('persists verification results', () => {
    runRepo.create('run-1');
    taskRepo.create({
      id: 'TASK-1',
      runId: 'run-1',
      title: 'T1',
      description: 'D1',
      type: 'implementation',
      status: 'verification',
    });

    verificationRepo.save('TASK-1', 'run-1', {
      passed: true,
      checks: [
        {
          name: 'test',
          command: 'npm test',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 100,
          success: true,
        },
      ],
    });

    const result = verificationRepo.getLatestByTask('TASK-1');
    expect(result).toBeDefined();
    expect(result?.passed).toBe(true);
    expect(result?.checks.length).toBe(1);
  });
});
