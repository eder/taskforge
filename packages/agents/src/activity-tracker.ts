import { ActiveAgentState, ReviewFinding } from '@taskforge/shared';

export type ActivityListener = (active: ActiveAgentState[]) => void;

export class AgentActivityTracker {
  private activeMap = new Map<string, ActiveAgentState>();
  private listeners = new Set<ActivityListener>();

  public register(state: ActiveAgentState): void {
    this.activeMap.set(state.taskId, { ...state });
    this.notify();
  }

  public updateStatus(taskId: string, status: string): void {
    const existing = this.activeMap.get(taskId);
    if (existing) {
      existing.status = status;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public setAttention(
    taskId: string,
    attention: {
      type: 'permission' | 'question' | 'auth';
      prompt: string;
      resource?: string;
    },
  ): void {
    const existing = this.activeMap.get(taskId);
    if (existing) {
      existing.attentionRequired = attention;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public clearAttention(taskId: string): void {
    const existing = this.activeMap.get(taskId);
    if (existing) {
      existing.attentionRequired = undefined;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public setCriticalFindings(taskId: string, findings: ReviewFinding[]): void {
    const existing = this.activeMap.get(taskId);
    if (existing) {
      existing.criticalFindings = findings;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public clearCriticalFindings(taskId: string): void {
    const existing = this.activeMap.get(taskId);
    if (existing) {
      existing.criticalFindings = undefined;
      existing.lastActiveAt = new Date();
      this.notify();
    }
  }

  public complete(taskId: string): void {
    if (this.activeMap.delete(taskId)) {
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

  public getByTaskId(taskId: string): ActiveAgentState | undefined {
    return this.activeMap.get(taskId);
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
