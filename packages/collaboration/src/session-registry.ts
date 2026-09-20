import { AgentAdapter } from '@taskforge/agents';

export interface RegisteredSession {
  assignmentId: string;
  sessionId: string;
  adapter: AgentAdapter;
  taskId: string;
  runId: string;
}

export class SessionRegistry {
  private sessionsByAssignment: Map<string, RegisteredSession> = new Map();
  private sessionsById: Map<string, RegisteredSession> = new Map();

  register(session: RegisteredSession): void {
    this.sessionsByAssignment.set(session.assignmentId, session);
    this.sessionsById.set(session.sessionId, session);
  }

  unregister(assignmentId: string): void {
    const existing = this.sessionsByAssignment.get(assignmentId);
    if (existing) {
      this.sessionsByAssignment.delete(assignmentId);
      this.sessionsById.delete(existing.sessionId);
    }
  }

  getByAssignment(assignmentId: string): RegisteredSession | undefined {
    return this.sessionsByAssignment.get(assignmentId);
  }

  getBySessionId(sessionId: string): RegisteredSession | undefined {
    return this.sessionsById.get(sessionId);
  }

  listByTask(taskId: string): RegisteredSession[] {
    return Array.from(this.sessionsByAssignment.values()).filter((s) => s.taskId === taskId);
  }

  clear(): void {
    this.sessionsByAssignment.clear();
    this.sessionsById.clear();
  }
}
