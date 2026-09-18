import { describe, it, expect } from 'vitest';
import {
  CommunicationBus,
  AssignmentGraph,
  SynthesisCoordinator,
  EscalationHandler,
} from '../src/index.js';
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { CollaborationLimitError } from '@taskforge/shared';
import { FakeAgent } from '@taskforge/agents';

describe('Collaboration Package', () => {
  it('CommunicationBus records structured messages and respects guardrails', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const goalRepo = new (await import('@taskforge/persistence')).GoalRepository(db);
    const runRepo = new (await import('@taskforge/persistence')).RunRepository(db);
    const taskRepo = new (await import('@taskforge/persistence')).TaskRepository(db);

    goalRepo.create({ id: 'goal-1', description: 'Goal 1', repository: '/tmp' });
    runRepo.create('run-1', 'goal-1');
    taskRepo.create({
      id: 'task-1',
      runId: 'run-1',
      goalId: 'goal-1',
      title: 'Task 1',
      description: 'Desc',
      type: 'implementation',
      status: 'running',
    });

    const bus = new CommunicationBus(db, eventRepo, {
      maxMessagesPerRound: 2,
      maxRounds: 2,
    });

    const agentA = new FakeAgent('agent-a', 'Agent A');
    const agentB = new FakeAgent('agent-b', 'Agent B');
    bus.registerAgent('asgn-1', agentA);
    bus.registerAgent('asgn-2', agentB);

    // Send valid messages within limit
    const msg1 = await bus.sendMessage({
      runId: 'run-1',
      taskId: 'task-1',
      fromAssignmentId: 'asgn-1',
      toAssignmentId: 'asgn-2',
      type: 'query',
      body: 'Did you check the locking logic in db.ts?',
    });
    expect(msg1.id).toBeDefined();

    const msg2 = await bus.sendMessage({
      runId: 'run-1',
      taskId: 'task-1',
      fromAssignmentId: 'asgn-2',
      toAssignmentId: 'asgn-1',
      type: 'finding',
      body: 'Yes, discovered deadlock between lock A and lock B.',
    });
    expect(msg2.id).toBeDefined();

    // Delivered to agent adapter
    expect(agentB.receivedMessages.length).toBe(1);
    expect(agentA.receivedMessages.length).toBe(1);

    // Check DB record
    const rows = db.prepare('SELECT * FROM agent_messages WHERE run_id = ?').all('run-1');
    expect(rows.length).toBe(2);

    // Check event emission
    const events = eventRepo.listByRun('run-1');
    expect(events.filter((e) => e.type === 'AGENT_MESSAGE_SENT').length).toBe(2);

    // Send messages until exceeding round limits
    await bus.sendMessage({
      runId: 'run-1',
      taskId: 'task-1',
      fromAssignmentId: 'asgn-1',
      type: 'proposal',
      body: 'Round 2 message 1',
    });

    await bus.sendMessage({
      runId: 'run-1',
      taskId: 'task-1',
      fromAssignmentId: 'asgn-1',
      type: 'proposal',
      body: 'Round 2 message 2',
    });

    // 5th message exceeds maxRounds (2)
    await expect(
      bus.sendMessage({
        runId: 'run-1',
        taskId: 'task-1',
        fromAssignmentId: 'asgn-1',
        type: 'challenge',
        body: 'Exceeding guardrails',
      }),
    ).rejects.toThrow(CollaborationLimitError);

    db.close();
  });

  it('AssignmentGraph coordinates parallel investigation with synthesis dependency', () => {
    const graph = AssignmentGraph.buildParallelInvestigationGraph(
      'task-42',
      [
        { id: 'agent-1', role: 'researcher', objective: 'Investigate logs' },
        { id: 'agent-2', role: 'reproduction_engineer', objective: 'Repro test' },
      ],
      { id: 'agent-3', role: 'implementer', objective: 'Apply fix' },
      { id: 'agent-4', role: 'reviewer', objective: 'Review PR' },
    );

    const completed = new Set<string>();

    // Initially, only the 2 investigators are runnable
    let runnable = graph.getRunnableAssignments(completed);
    expect(runnable.length).toBe(2);
    expect(runnable.map((r) => r.role)).toEqual(['researcher', 'reproduction_engineer']);

    // Complete first investigator
    completed.add(runnable[0].id);
    runnable = graph.getRunnableAssignments(completed);
    expect(runnable.length).toBe(1);
    expect(runnable[0].role).toBe('reproduction_engineer');

    // Complete second investigator -> now synthesis is runnable
    completed.add(runnable[0].id);
    runnable = graph.getRunnableAssignments(completed);
    expect(runnable.length).toBe(1);
    expect(runnable[0].id).toContain('synthesis');

    // Complete synthesis -> now implementer is runnable
    completed.add(runnable[0].id);
    runnable = graph.getRunnableAssignments(completed);
    expect(runnable.length).toBe(1);
    expect(runnable[0].role).toBe('implementer');

    // Complete implementer -> now reviewer is runnable
    completed.add(runnable[0].id);
    runnable = graph.getRunnableAssignments(completed);
    expect(runnable.length).toBe(1);
    expect(runnable[0].role).toBe('reviewer');
  });

  it('SynthesisCoordinator aggregates outputs into cohesive fix spec', () => {
    const res = SynthesisCoordinator.synthesize({
      taskId: 'task-1',
      investigationOutputs: [
        { role: 'researcher', agentId: 'agent-1', output: 'Found memory leak in worker pool' },
        { role: 'reproduction_engineer', agentId: 'agent-2', output: 'Created repro script demonstrating OOM' },
      ],
    });

    expect(res.rootCause).toContain('memory leak');
    expect(res.recommendedFix).toBeDefined();
    expect(res.requiredTest).toBeDefined();
  });

  it('EscalationHandler records COLLABORATION_ESCALATED event', () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const handler = new EscalationHandler(eventRepo);

    handler.handleEscalation({
      runId: 'run-esc-1',
      taskId: 'task-esc-1',
      workerAgentId: 'codex-worker',
      proposal: {
        reason: 'Architecture refactor needed across multiple modules',
        requestedRoles: ['researcher', 'architecture_reviewer'],
        expectedBenefit: 'Avoid breaking core abstractions',
        urgency: 'high',
      },
    });

    const events = eventRepo.listByRun('run-esc-1');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('COLLABORATION_ESCALATED');
    expect(events[0].payload.initiator).toBe('codex-worker');
    expect(events[0].payload.urgency).toBe('high');

    db.close();
  });
});
