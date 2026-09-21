import { ActiveAgentState, ReviewFinding } from '@taskforge/shared';

export type ActivityListener = (active: ActiveAgentState[]) => void;

/**
 * Tracks live agent activity keyed by assignmentId, not taskId. A single task
 * can have several assignments running concurrently (e.g. a parallel
 * investigation team of Codex + Antigravity + Claude), and each one must be
 * independently observable and independently completable -- keying by taskId
 * would let concurrent assignments on the same task overwrite one another.
 */
export class AgentActivityTracker {
  private activeMap = new Map<string, ActiveAgentState>();
  private listeners = new Set<ActivityListener>();

  public register(state: ActiveAgentState): void {
    this.activeMap.set(state.assignmentId, { ...state });
    this.notify();
  }

  public updateStatus(assignmentId: string, status: string): void {
    const existing = this.activeMap.get(assignmentId);
    if (existing) {
      existing.status = status;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public setAttention(
    assignmentId: string,
    attention: NonNullable<ActiveAgentState['attentionRequired']>,
  ): void {
    const existing = this.activeMap.get(assignmentId);
    if (existing) {
      existing.attentionRequired = attention;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public clearAttention(assignmentId: string): void {
    const existing = this.activeMap.get(assignmentId);
    if (existing) {
      existing.attentionRequired = undefined;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public markRecovered(
    assignmentId: string,
    recovery: {
      failedAgentId: string;
      failedAgentName: string;
      reason?: string;
      resetAt?: string;
    },
    ttlMs = 8000,
  ): void {
    const existing = this.activeMap.get(assignmentId);
    if (existing) {
      const recoveredAt = new Date();
      existing.recovery = {
        ...recovery,
        recoveredAt,
        recoveredUntil: new Date(recoveredAt.getTime() + ttlMs),
      };
      existing.lastActiveAt = recoveredAt;
      this.notify();
    }
  }

  public setCriticalFindings(assignmentId: string, findings: ReviewFinding[]): void {
    const existing = this.activeMap.get(assignmentId);
    if (existing) {
      existing.criticalFindings = findings;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public clearCriticalFindings(assignmentId: string): void {
    const existing = this.activeMap.get(assignmentId);
    if (existing) {
      existing.criticalFindings = undefined;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  /** Finishes and removes a single assignment, leaving other assignments on the same task untouched. */
  public completeAssignment(assignmentId: string): void {
    if (this.activeMap.delete(assignmentId)) {
      this.notify();
    }
  }

  /** Finishes and removes every assignment currently tracked for a task (e.g. task-level cancel/teardown). */
  public completeTask(taskId: string): void {
    let changed = false;
    for (const [assignmentId, state] of this.activeMap) {
      if (state.taskId === taskId) {
        this.activeMap.delete(assignmentId);
        changed = true;
      }
    }
    if (changed) {
      this.notify();
    }
  }

  public clear(): void {
    this.activeMap.clear();
    this.notify();
  }

  public getActive(): ActiveAgentState[] {
    return Array.from(this.activeMap.values());
  }

  public getByAssignment(assignmentId: string): ActiveAgentState | undefined {
    return this.activeMap.get(assignmentId);
  }

  /** All active assignments for a task -- may be more than one for a concurrent team. */
  public getByTask(taskId: string): ActiveAgentState[] {
    return this.getActive().filter((state) => state.taskId === taskId);
  }

  public subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const list = this.getActive();
    for (const listener of this.listeners) {
      try {
        listener(list);
      } catch {
        // Safe dispatch: ignore subscriber runtime errors
      }
    }
  }
}
