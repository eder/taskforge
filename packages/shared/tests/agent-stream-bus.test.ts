import { describe, it, expect, vi } from 'vitest';
import { AgentStreamBus } from '../src/agent-stream-bus.js';
import { AgentStreamEvent } from '../src/agent-stream-event.js';

function makeEvent(overrides: Partial<AgentStreamEvent> & { assignmentId: string }): AgentStreamEvent {
  return {
    type: 'status',
    status: 'working',
    timestamp: new Date(),
    runId: 'run-1',
    taskId: 'TASK-01',
    agentId: 'codex',
    role: 'implementer',
    ...overrides,
  } as AgentStreamEvent;
}

describe('AgentStreamBus', () => {
  it('delivers published events to subscribeAll listeners', () => {
    const bus = new AgentStreamBus();
    const listener = vi.fn();
    bus.subscribeAll(listener);

    const event = makeEvent({ assignmentId: 'asgn-a' });
    bus.publish(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('delivers published events only to matching assignment-scoped listeners', () => {
    const bus = new AgentStreamBus();
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    bus.subscribeAssignment('asgn-a', listenerA);
    bus.subscribeAssignment('asgn-b', listenerB);

    bus.publish(makeEvent({ assignmentId: 'asgn-a' }));

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new AgentStreamBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribeAll(listener);

    bus.publish(makeEvent({ assignmentId: 'asgn-a' }));
    unsubscribe();
    bus.publish(makeEvent({ assignmentId: 'asgn-a' }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a bounded ring buffer of recent history per assignment', () => {
    const bus = new AgentStreamBus(5);
    for (let i = 0; i < 10; i++) {
      bus.publish(makeEvent({ assignmentId: 'asgn-a', status: `step-${i}` }));
    }

    const history = bus.history('asgn-a');
    expect(history).toHaveLength(5);
    expect((history[0] as any).status).toBe('step-5');
    expect((history[4] as any).status).toBe('step-9');
  });

  it('history() for one assignment never includes events from another assignment', () => {
    const bus = new AgentStreamBus();
    bus.publish(makeEvent({ assignmentId: 'asgn-a' }));
    bus.publish(makeEvent({ assignmentId: 'asgn-b' }));
    bus.publish(makeEvent({ assignmentId: 'asgn-a' }));

    expect(bus.history('asgn-a')).toHaveLength(2);
    expect(bus.history('asgn-b')).toHaveLength(1);
  });

  it('a throwing subscriber never breaks publish() for other subscribers or the caller', () => {
    const bus = new AgentStreamBus();
    const broken = vi.fn(() => {
      throw new Error('boom');
    });
    const healthy = vi.fn();
    bus.subscribeAll(broken);
    bus.subscribeAll(healthy);

    expect(() => bus.publish(makeEvent({ assignmentId: 'asgn-a' }))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('clearAssignment drops the buffer for that assignment only', () => {
    const bus = new AgentStreamBus();
    bus.publish(makeEvent({ assignmentId: 'asgn-a' }));
    bus.publish(makeEvent({ assignmentId: 'asgn-b' }));

    bus.clearAssignment('asgn-a');

    expect(bus.history('asgn-a')).toHaveLength(0);
    expect(bus.history('asgn-b')).toHaveLength(1);
  });
});
