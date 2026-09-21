import { AgentStreamEvent } from './agent-stream-event.js';

export type AgentStreamListener = (event: AgentStreamEvent) => void;

const DEFAULT_RING_BUFFER_SIZE = 300;

/**
 * In-process pub/sub for live agent activity, keyed by assignmentId. A
 * bounded ring buffer per assignment lets the UI reconstruct recent history
 * when switching focus between agents, without needing to replay the entire
 * (separately, fully persisted) raw log. Publishing is synchronous and
 * deliberately cannot throw back into the caller -- a slow or broken UI
 * subscriber must never block or crash agent execution.
 */
export class AgentStreamBus {
  private buffers = new Map<string, AgentStreamEvent[]>();
  private allListeners = new Set<AgentStreamListener>();
  private assignmentListeners = new Map<string, Set<AgentStreamListener>>();

  constructor(private ringBufferSize: number = DEFAULT_RING_BUFFER_SIZE) {}

  publish(event: AgentStreamEvent): void {
    const buffer = this.buffers.get(event.assignmentId) ?? [];
    buffer.push(event);
    if (buffer.length > this.ringBufferSize) {
      buffer.splice(0, buffer.length - this.ringBufferSize);
    }
    this.buffers.set(event.assignmentId, buffer);

    for (const listener of this.allListeners) {
      this.dispatch(listener, event);
    }
    const scoped = this.assignmentListeners.get(event.assignmentId);
    if (scoped) {
      for (const listener of scoped) {
        this.dispatch(listener, event);
      }
    }
  }

  subscribeAll(listener: AgentStreamListener): () => void {
    this.allListeners.add(listener);
    return () => {
      this.allListeners.delete(listener);
    };
  }

  subscribeAssignment(assignmentId: string, listener: AgentStreamListener): () => void {
    let set = this.assignmentListeners.get(assignmentId);
    if (!set) {
      set = new Set();
      this.assignmentListeners.set(assignmentId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.assignmentListeners.delete(assignmentId);
      }
    };
  }

  /** Recent events for one assignment, oldest first, bounded by the ring buffer size. */
  history(assignmentId: string): AgentStreamEvent[] {
    return [...(this.buffers.get(assignmentId) ?? [])];
  }

  /** Drops the buffer and listeners for a finished assignment. */
  clearAssignment(assignmentId: string): void {
    this.buffers.delete(assignmentId);
    this.assignmentListeners.delete(assignmentId);
  }

  private dispatch(listener: AgentStreamListener, event: AgentStreamEvent): void {
    try {
      listener(event);
    } catch {
      // A subscriber (UI render, etc.) must never be able to break publish().
    }
  }
}
