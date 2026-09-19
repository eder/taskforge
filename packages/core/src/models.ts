import {
  Constraint,
  TaskContract,
  TaskStatus,
  TaskType,
  InvalidTaskGraphError,
} from '@taskforge/shared';

export interface Goal {
  id: string;
  description: string;
  repository: string;
  constraints: Constraint[];
  acceptanceCriteria: string[];
  createdAt: Date;
}

export interface Task {
  id: string;
  goalId: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  dependencies: string[];
  contract: TaskContract;
  acceptanceCriteria: string[];
  reworkCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class TaskStateMachine {
  private static readonly VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
    proposed: ['preflight', 'failed', 'blocked'],
    preflight: ['negotiating', 'accepted', 'failed', 'blocked'],
    negotiating: ['accepted', 'failed', 'blocked'],
    accepted: ['ready', 'blocked', 'failed'],
    ready: ['assigned', 'blocked', 'failed'],
    assigned: ['running', 'blocked', 'failed'],
    running: ['completed', 'failed', 'blocked', 'waiting_input', 'waiting_permission', 'waiting_auth'],
    waiting_input: ['running', 'failed', 'blocked'],
    waiting_permission: ['running', 'failed', 'blocked'],
    waiting_auth: ['running', 'failed', 'blocked'],
    completed: ['verification', 'failed', 'blocked'],
    verification: ['verified', 'failed', 'blocked'],
    verified: ['integrated', 'blocked'],
    integrated: [],
    failed: ['retrying', 'reassigned', 'collaborative_escalation', 'blocked'],
    retrying: ['ready', 'blocked', 'failed'],
    reassigned: ['ready', 'blocked', 'failed'],
    collaborative_escalation: ['negotiating', 'ready', 'blocked', 'failed'],
    blocked: ['ready', 'failed'],
  };

  public static canTransition(current: TaskStatus, next: TaskStatus): boolean {
    if (current === next) return true;
    const allowed = this.VALID_TRANSITIONS[current] ?? [];
    return allowed.includes(next);
  }

  public static transition(task: Task, next: TaskStatus): Task {
    if (!this.canTransition(task.status, next)) {
      throw new InvalidTaskGraphError(
        `Invalid task state transition for ${task.id}: cannot move from '${task.status}' to '${next}'`,
        { taskId: task.id, from: task.status, to: next },
      );
    }
    return {
      ...task,
      status: next,
      updatedAt: new Date(),
    };
  }
}
