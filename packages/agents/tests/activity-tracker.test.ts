import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentActivityTracker } from '../src/activity-tracker.js';
import { ActiveAgentState } from '@taskforge/shared';

describe('AgentActivityTracker', () => {
  let tracker: AgentActivityTracker;

  beforeEach(() => {
    tracker = new AgentActivityTracker();
  });

  it('registers active agent states and retrieves them', () => {
    const state: ActiveAgentState = {
      taskId: 'task-1',
      agentId: 'claude',
      agentName: 'Claude Code',
      status: 'Cloning workspace...',
      startedAt: new Date(),
      lastActiveAt: new Date(),
      worktreePath: '/tmp/worktree-1',
    };

    tracker.register(state);

    const active = tracker.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.taskId).toBe('task-1');
    expect(active[0]?.agentName).toBe('Claude Code');

    const byId = tracker.getByTaskId('task-1');
    expect(byId).toBeDefined();
    expect(byId?.agentId).toBe('claude');
  });

  it('updates status and lastActiveAt on existing agents', () => {
    const started = new Date(Date.now() - 5000);
    const state: ActiveAgentState = {
      taskId: 'task-2',
      agentId: 'codex',
      agentName: 'Codex CLI',
      status: 'Starting...',
      startedAt: started,
      lastActiveAt: started,
    };

    tracker.register(state);
    tracker.updateStatus('task-2', 'Running npm test');

    const updated = tracker.getByTaskId('task-2');
    expect(updated?.status).toBe('Running npm test');
    expect(updated?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(started.getTime());
  });

  it('sets and clears human-in-the-loop attention requirement', () => {
    const state: ActiveAgentState = {
      taskId: 'task-3',
      agentId: 'agy',
      agentName: 'Antigravity CLI',
      status: 'Executing',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    };

    tracker.register(state);

    tracker.setAttention('task-3', {
      type: 'permission',
      prompt: 'Allow execution of rm -rf build?',
      resource: 'command',
    });

    let current = tracker.getByTaskId('task-3');
    expect(current?.attentionRequired).toBeDefined();
    expect(current?.attentionRequired?.type).toBe('permission');
    expect(current?.attentionRequired?.prompt).toBe('Allow execution of rm -rf build?');

    tracker.clearAttention('task-3');
    current = tracker.getByTaskId('task-3');
    expect(current?.attentionRequired).toBeUndefined();
  });

  it('removes tasks on complete() and clears all on clear()', () => {
    tracker.register({
      taskId: 't-1',
      agentId: 'a1',
      agentName: 'Agent 1',
      status: 'Running',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
    tracker.register({
      taskId: 't-2',
      agentId: 'a2',
      agentName: 'Agent 2',
      status: 'Running',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });

    expect(tracker.getActive()).toHaveLength(2);

    tracker.complete('t-1');
    expect(tracker.getActive()).toHaveLength(1);
    expect(tracker.getByTaskId('t-1')).toBeUndefined();
    expect(tracker.getByTaskId('t-2')).toBeDefined();

    tracker.clear();
    expect(tracker.getActive()).toHaveLength(0);
  });

  it('notifies subscribers upon state changes and allows unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);

    tracker.register({
      taskId: 't-sub',
      agentId: 'sub-agent',
      agentName: 'Subscriber Test',
      status: 'Init',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ taskId: 't-sub' })]),
    );

    tracker.updateStatus('t-sub', 'New status');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    tracker.complete('t-sub');
    expect(listener).toHaveBeenCalledTimes(2); // No more calls after unsubscribe
  });
});
