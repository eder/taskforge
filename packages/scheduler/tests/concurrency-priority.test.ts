import { describe, it, expect } from 'vitest';
import { TaskForgeConfig } from '@taskforge/shared';
import { TaskGraph, Task, computeTaskPriority, calculateTaskPriorityFactors } from '@taskforge/core';
import { ConcurrencyManager, TeamMemberReservation } from '../src/concurrency-manager.js';

function createMockTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? 'TASK-1';
  return {
    id,
    goalId: 'goal-test',
    title: `Task ${id}`,
    description: `Description for ${id}`,
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: `Objective ${id}`,
      allowedScope: [],
      forbiddenChanges: [],
      acceptanceCriteria: [],
      dependencies: overrides.dependencies ?? [],
      metadata: overrides.contract?.metadata,
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('Dynamic Concurrency Slot Prioritization', () => {
  it('computes task priority based on dependency blocking, criticality, rework and type', () => {
    const root = createMockTask({ id: 'ROOT' });
    const child1 = createMockTask({ id: 'CHILD-1', dependencies: ['ROOT'] });
    const child2 = createMockTask({ id: 'CHILD-2', dependencies: ['ROOT'] });
    const grandchild = createMockTask({ id: 'GRANDCHILD', dependencies: ['CHILD-1'] });
    const leaf = createMockTask({ id: 'LEAF' });

    const graph = new TaskGraph([root, child1, child2, grandchild, leaf]);

    // ROOT blocks 3 transitive downstream tasks (CHILD-1, CHILD-2, GRANDCHILD) -> 3 * 10 = 30
    const rootPrio = computeTaskPriority(root, graph);
    expect(rootPrio).toBe(30);

    // LEAF blocks 0 tasks -> 0
    const leafPrio = computeTaskPriority(leaf, graph);
    expect(leafPrio).toBe(0);

    // Critical metadata adds substantial weight
    const criticalTask = createMockTask({
      id: 'CRITICAL',
      contract: {
        objective: 'Critical auth fix',
        allowedScope: [],
        forbiddenChanges: [],
        acceptanceCriteria: [],
        dependencies: [],
        metadata: { priority: 'critical', risk: 'high' },
      },
    });
    const factors = calculateTaskPriorityFactors(criticalTask);
    expect(factors.criticalityScore).toBe(90); // 50 (critical priority) + 40 (high risk)
    expect(factors.total).toBe(90);

    // Rework count prioritizes failing tasks to unblock pipeline
    const reworkTask = createMockTask({ id: 'REWORK', reworkCount: 2 });
    expect(computeTaskPriority(reworkTask)).toBe(30); // 2 * 15 = 30

    // Architecture tasks establish foundations
    const archTask = createMockTask({ id: 'ARCH', type: 'architecture' });
    expect(computeTaskPriority(archTask)).toBe(15);
  });

  it('releases a task-level reservation when its lead assignment finishes so a partner can run', async () => {
    const config: TaskForgeConfig = {
      agents: {
        claude: { maxParallel: 2, command: 'echo', timeoutMs: 5000 },
        codex: { maxParallel: 2, command: 'echo', timeoutMs: 5000 },
        agy: { maxParallel: 1, command: 'echo', timeoutMs: 5000 },
      },
      execution: {
        maxParallelTasks: 3,
        defaultTimeoutMs: 5000,
        enableInteractionGateway: true,
      },
      git: {
        defaultBranch: 'main',
        integrationBranchPrefix: 'tf/',
        worktreeDir: '.taskforge/worktrees',
        commitMessagePrefix: 'tf: ',
      },
      verification: {
        maxReworkCycles: 2,
        defaultChecks: [],
      },
    };

    const cm = new ConcurrencyManager(config);

    // Reproduce the scheduler state from the recorded hang: three tasks have
    // consumed all global slots before their collaborative handoffs start.
    cm.acquire('TASK-A', 'claude');
    cm.acquire('TASK-B', 'codex');
    cm.acquire('TASK-C', 'agy');
    expect(cm.getActiveCount()).toBe(3);

    // TASK-A's lead uses its existing task reservation.
    await cm.waitForSlot('claude', 'TASK-A', undefined, 'asgn-a-lead');
    cm.acquire('asgn-a-lead', 'claude', 'TASK-A');

    // Partner cannot run while all three scheduler reservations are held.
    let partnerAcquired = false;
    const partnerPromise = cm
      .waitForSlot('codex', 'TASK-A', undefined, 'asgn-a-partner')
      .then(() => {
        partnerAcquired = true;
        cm.acquire('asgn-a-partner', 'codex', 'TASK-A');
      });

    expect(partnerAcquired).toBe(false);
    expect(cm.getWaitingCount()).toBe(1);

    // Finishing the lead must release TASK-A's scheduler reservation, opening
    // a real assignment slot for the partner instead of waiting for task end.
    cm.release('asgn-a-lead', 'claude', 'TASK-A');
    await partnerPromise;

    expect(partnerAcquired).toBe(true);
    expect(cm.getWaitingCount()).toBe(0);
    expect(cm.getActiveTaskCount()).toBe(2);

    cm.release('asgn-a-partner', 'codex', 'TASK-A');
    cm.release('TASK-B', 'codex');
    cm.release('TASK-C', 'agy');
  });

  it('prioritizes higher-priority queued tasks over lower-priority tasks when team slots are freed', async () => {
    const config: TaskForgeConfig = {
      agents: {
        claude: { maxParallel: 1, command: 'echo', timeoutMs: 5000 },
        codex: { maxParallel: 1, command: 'echo', timeoutMs: 5000 },
      },
      execution: {
        maxParallelTasks: 2,
        defaultTimeoutMs: 5000,
        enableInteractionGateway: true,
      },
      git: {
        defaultBranch: 'main',
        integrationBranchPrefix: 'tf/',
        worktreeDir: '.taskforge/worktrees',
        commitMessagePrefix: 'tf: ',
      },
      verification: {
        maxReworkCycles: 2,
        defaultChecks: [],
      },
    };

    const cm = new ConcurrencyManager(config);

    // Initial occupancy: fill both available slots
    const initialTeam: TeamMemberReservation[] = [
      { taskId: 'TASK-OCCUPIED-1', assignmentId: 'asgn-occ-1', agentId: 'claude' },
      { taskId: 'TASK-OCCUPIED-2', assignmentId: 'asgn-occ-2', agentId: 'codex' },
    ];
    await cm.waitForTeamSlots(initialTeam);

    expect(cm.getActiveCount()).toBe(2);
    expect(cm.canSchedule('claude')).toBe(false);
    expect(cm.canSchedule('codex')).toBe(false);

    // Order tracking for slot acquisition
    const acquisitionOrder: string[] = [];

    // Queue Task Low (priority: 5) first
    const lowTeam: TeamMemberReservation[] = [
      { taskId: 'TASK-LOW', assignmentId: 'asgn-low-1', agentId: 'claude' },
    ];
    const lowPromise = cm
      .waitForTeamSlots(lowTeam, undefined, 5, 'TASK-LOW')
      .then(() => {
        acquisitionOrder.push('TASK-LOW');
      });

    // Queue Task High (priority: 80, e.g. dependency blocking or critical) second
    const highTeam: TeamMemberReservation[] = [
      { taskId: 'TASK-HIGH', assignmentId: 'asgn-high-1', agentId: 'claude' },
    ];
    const highPromise = cm
      .waitForTeamSlots(highTeam, undefined, 80, 'TASK-HIGH')
      .then(() => {
        acquisitionOrder.push('TASK-HIGH');
      });

    // Verify both are waiting in the ConcurrencyManager queue
    expect(cm.getWaitingCount()).toBe(2);
    const waiters = cm.getWaiters();
    expect(waiters.map((w) => w.taskId)).toEqual(['TASK-LOW', 'TASK-HIGH']);

    // Release claude from first task: capacity of 1 on claude opens up
    cm.release('asgn-occ-1');

    // High priority waiter MUST acquire the slot before low priority waiter
    await highPromise;
    expect(acquisitionOrder).toEqual(['TASK-HIGH']);
    expect(cm.getWaitingCount()).toBe(1);

    // Now release claude from the high priority task
    cm.release('asgn-high-1');

    // Low priority waiter now acquires the slot
    await lowPromise;
    expect(acquisitionOrder).toEqual(['TASK-HIGH', 'TASK-LOW']);
    expect(cm.getWaitingCount()).toBe(0);

    // Clean up remaining reservations
    cm.release('asgn-occ-2');
    cm.release('asgn-low-1');
  });

  it('prioritizes single-agent slot waiters according to priority score', async () => {
    const config: TaskForgeConfig = {
      agents: {
        claude: { maxParallel: 1, command: 'echo', timeoutMs: 5000 },
      },
      execution: {
        maxParallelTasks: 1,
        defaultTimeoutMs: 5000,
        enableInteractionGateway: true,
      },
      git: {
        defaultBranch: 'main',
        integrationBranchPrefix: 'tf/',
        worktreeDir: '.taskforge/worktrees',
        commitMessagePrefix: 'tf: ',
      },
      verification: {
        maxReworkCycles: 2,
        defaultChecks: [],
      },
    };

    const cm = new ConcurrencyManager(config);

    // Occupy the single slot
    cm.acquire('task-busy', 'claude');
    expect(cm.canSchedule('claude')).toBe(false);

    const order: string[] = [];

    // Enqueue low priority waiter
    const pLow = cm
      .waitForSlot('claude', 'task-low', undefined, 'asgn-low', 0)
      .then(() => {
        order.push('LOW');
        cm.acquire('asgn-low', 'claude', 'task-low');
      });

    // Enqueue urgent priority waiter
    const pUrgent = cm
      .waitForSlot('claude', 'task-urgent', undefined, 'asgn-urgent', 100)
      .then(() => {
        order.push('URGENT');
        cm.acquire('asgn-urgent', 'claude', 'task-urgent');
      });

    // Enqueue medium priority waiter
    const pMedium = cm
      .waitForSlot('claude', 'task-medium', undefined, 'asgn-medium', 40)
      .then(() => {
        order.push('MEDIUM');
        cm.acquire('asgn-medium', 'claude', 'task-medium');
      });

    expect(cm.getWaitingCount()).toBe(3);

    // Release busy task: URGENT should win
    cm.release('task-busy');
    await pUrgent;
    expect(order).toEqual(['URGENT']);

    // Release urgent: MEDIUM should win next
    cm.release('asgn-urgent');
    await pMedium;
    expect(order).toEqual(['URGENT', 'MEDIUM']);

    // Release medium: LOW should win last
    cm.release('asgn-medium');
    await pLow;
    expect(order).toEqual(['URGENT', 'MEDIUM', 'LOW']);

    cm.release('asgn-low');
  });

  it('prioritizes competing multi-agent teams based on dependency-blocking priority', async () => {
    const config: TaskForgeConfig = {
      agents: {
        claude: { maxParallel: 2, command: 'echo', timeoutMs: 5000 },
        codex: { maxParallel: 2, command: 'echo', timeoutMs: 5000 },
      },
      execution: {
        maxParallelTasks: 2, // Total system concurrency limit is 2
        defaultTimeoutMs: 5000,
        enableInteractionGateway: true,
      },
      git: {
        defaultBranch: 'main',
        integrationBranchPrefix: 'tf/',
        worktreeDir: '.taskforge/worktrees',
        commitMessagePrefix: 'tf: ',
      },
      verification: {
        maxReworkCycles: 2,
        defaultChecks: [],
      },
    };

    const cm = new ConcurrencyManager(config);

    // Initial occupancy: fill the 2 slots
    cm.acquire('init-1', 'claude');
    cm.acquire('init-2', 'codex');
    expect(cm.getActiveCount()).toBe(2);

    // Team Low: 2 members (claude + codex), priority = 0
    const teamLow: TeamMemberReservation[] = [
      { taskId: 'TASK-LEAF', assignmentId: 'asgn-leaf-1', agentId: 'claude' },
      { taskId: 'TASK-LEAF', assignmentId: 'asgn-leaf-2', agentId: 'codex' },
    ];

    // Team High: 2 members (claude + codex), priority = 50 (blocks dependencies)
    const teamHigh: TeamMemberReservation[] = [
      { taskId: 'TASK-BLOCKER', assignmentId: 'asgn-block-1', agentId: 'claude' },
      { taskId: 'TASK-BLOCKER', assignmentId: 'asgn-block-2', agentId: 'codex' },
    ];

    const teamOrder: string[] = [];

    // Enqueue Team Low first
    const pTeamLow = cm.waitForTeamSlots(teamLow, undefined, 0, 'TASK-LEAF').then(() => {
      teamOrder.push('TEAM-LEAF');
    });

    // Enqueue Team High second
    const pTeamHigh = cm.waitForTeamSlots(teamHigh, undefined, 50, 'TASK-BLOCKER').then(() => {
      teamOrder.push('TEAM-BLOCKER');
    });

    expect(cm.getWaitingCount()).toBe(2);

    // Free both initial slots
    cm.release('init-1');
    cm.release('init-2');

    // High priority team must win both slots!
    await pTeamHigh;
    expect(teamOrder).toEqual(['TEAM-BLOCKER']);
    expect(cm.getActiveCount()).toBe(2);
    expect(cm.getWaitingCount()).toBe(1);

    // Release high priority team
    cm.releaseTeam(teamHigh);

    // Now low priority team acquires the slots
    await pTeamLow;
    expect(teamOrder).toEqual(['TEAM-BLOCKER', 'TEAM-LEAF']);
    expect(cm.getWaitingCount()).toBe(0);

    cm.releaseTeam(teamLow);
  });
});
