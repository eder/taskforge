import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentActivityTracker } from '../src/activity-tracker.js';
import { ActiveAgentState } from '@taskforge/shared';

function makeState(overrides: Partial<ActiveAgentState> & { assignmentId: string }): ActiveAgentState {
  return {
    taskId: 'task-1',
    taskTitle: 'Some task',
    agentId: 'claude',
    agentName: 'Claude Code',
    role: 'implementer',
    status: 'Cloning workspace...',
    startedAt: new Date(),
    lastActiveAt: new Date(),
    ...overrides,
  };
}

describe('AgentActivityTracker', () => {
  let tracker: AgentActivityTracker;

  beforeEach(() => {
    tracker = new AgentActivityTracker();
  });

  it('registers active agent states and retrieves them by assignment', () => {
    const state = makeState({ assignmentId: 'asgn-1', taskId: 'task-1' });
    tracker.register(state);

    const active = tracker.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.taskId).toBe('task-1');
    expect(active[0]?.agentName).toBe('Claude Code');

    const byAssignment = tracker.getByAssignment('asgn-1');
    expect(byAssignment).toBeDefined();
    expect(byAssignment?.agentId).toBe('claude');
  });

  it('updates status and lastActiveAt for a specific assignment', () => {
    const started = new Date(Date.now() - 5000);
    const state = makeState({
      assignmentId: 'asgn-2',
      taskId: 'task-2',
      agentId: 'codex',
      agentName: 'Codex CLI',
      status: 'Starting...',
      startedAt: started,
      lastActiveAt: started,
    });

    tracker.register(state);
    tracker.updateStatus('asgn-2', 'Running npm test');

    const updated = tracker.getByAssignment('asgn-2');
    expect(updated?.status).toBe('Running npm test');
    expect(updated?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(started.getTime());
  });

  it('sets and clears human-in-the-loop attention requirement per assignment', () => {
    const state = makeState({
      assignmentId: 'asgn-3',
      taskId: 'task-3',
      agentId: 'agy',
      agentName: 'Antigravity CLI',
      status: 'Executing',
    });

    tracker.register(state);

    tracker.setAttention('asgn-3', {
      type: 'permission',
      prompt: 'Allow execution of rm -rf build?',
      resource: 'command',
    });

    let current = tracker.getByAssignment('asgn-3');
    expect(current?.attentionRequired).toBeDefined();
    expect(current?.attentionRequired?.type).toBe('permission');
    expect(current?.attentionRequired?.prompt).toBe('Allow execution of rm -rf build?');

    tracker.clearAttention('asgn-3');
    current = tracker.getByAssignment('asgn-3');
    expect(current?.attentionRequired).toBeUndefined();
  });

  it('removes only the completed assignment on completeAssignment(), and clears all on clear()', () => {
    tracker.register(makeState({ assignmentId: 'asgn-t1', taskId: 't-1', agentId: 'a1', agentName: 'Agent 1' }));
    tracker.register(makeState({ assignmentId: 'asgn-t2', taskId: 't-2', agentId: 'a2', agentName: 'Agent 2' }));

    expect(tracker.getActive()).toHaveLength(2);

    tracker.completeAssignment('asgn-t1');
    expect(tracker.getActive()).toHaveLength(1);
    expect(tracker.getByAssignment('asgn-t1')).toBeUndefined();
    expect(tracker.getByAssignment('asgn-t2')).toBeDefined();

    tracker.clear();
    expect(tracker.getActive()).toHaveLength(0);
  });

  it('keeps multiple concurrent assignments for the same task independently addressable', () => {
    tracker.register(
      makeState({ assignmentId: 'asgn-a', taskId: 'TASK-01', agentId: 'codex', agentName: 'Codex', role: 'reproduction_engineer' }),
    );
    tracker.register(
      makeState({ assignmentId: 'asgn-b', taskId: 'TASK-01', agentId: 'agy', agentName: 'Antigravity', role: 'researcher' }),
    );
    tracker.register(
      makeState({ assignmentId: 'asgn-c', taskId: 'TASK-01', agentId: 'claude', agentName: 'Claude', role: 'architecture_reviewer' }),
    );

    // All three assignments coexist -- registering a second/third agent on the
    // same task must never overwrite the others.
    expect(tracker.getActive()).toHaveLength(3);
    expect(tracker.getByTask('TASK-01')).toHaveLength(3);

    tracker.updateStatus('asgn-b', 'Reading context_retrieval.py');
    expect(tracker.getByAssignment('asgn-a')?.status).not.toBe('Reading context_retrieval.py');
    expect(tracker.getByAssignment('asgn-b')?.status).toBe('Reading context_retrieval.py');

    // Completing one assignment must not remove the others on the same task.
    tracker.completeAssignment('asgn-b');
    expect(tracker.getByTask('TASK-01')).toHaveLength(2);
    expect(tracker.getByAssignment('asgn-a')).toBeDefined();
    expect(tracker.getByAssignment('asgn-c')).toBeDefined();
    expect(tracker.getByAssignment('asgn-b')).toBeUndefined();
  });

  it('completeTask() removes every assignment for a task without touching other tasks', () => {
    tracker.register(makeState({ assignmentId: 'asgn-x1', taskId: 'TASK-X', agentId: 'codex', agentName: 'Codex' }));
    tracker.register(makeState({ assignmentId: 'asgn-x2', taskId: 'TASK-X', agentId: 'claude', agentName: 'Claude' }));
    tracker.register(makeState({ assignmentId: 'asgn-y1', taskId: 'TASK-Y', agentId: 'agy', agentName: 'Antigravity' }));

    tracker.completeTask('TASK-X');

    expect(tracker.getByTask('TASK-X')).toHaveLength(0);
    expect(tracker.getByTask('TASK-Y')).toHaveLength(1);
    expect(tracker.getActive()).toHaveLength(1);
  });

  it('notifies subscribers upon state changes and allows unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);

    tracker.register(makeState({ assignmentId: 'asgn-sub', taskId: 't-sub', agentId: 'sub-agent', agentName: 'Subscriber Test', status: 'Init' }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ taskId: 't-sub' })]),
    );

    tracker.updateStatus('asgn-sub', 'New status');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    tracker.completeAssignment('asgn-sub');
    expect(listener).toHaveBeenCalledTimes(2); // No more calls after unsubscribe
  });
});
