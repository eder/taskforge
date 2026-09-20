import { randomUUID } from 'node:crypto';
import { TaskForgeConfig } from '@taskforge/shared';

export interface ActiveAssignmentInfo {
  agentId: string;
  taskId: string;
}

export interface TeamMemberReservation {
  taskId: string;
  assignmentId: string;
  agentId: string;
}

export interface ConcurrencyWaiter {
  id: string;
  priority: number;
  sequence: number;
  taskId?: string;
  check: () => boolean;
}

export class ConcurrencyManager {
  private activeTasks: Map<string, string> = new Map(); // taskId -> agentId
  private activeAssignments: Map<string, ActiveAssignmentInfo> = new Map();
  private agentActiveCounts: Map<string, number> = new Map();
  private waiters: ConcurrencyWaiter[] = [];
  private waiterSequence = 0;

  constructor(private config: TaskForgeConfig) {}

  canSchedule(agentId: string): boolean {
    const totalActive = Math.max(this.activeTasks.size, this.activeAssignments.size);
    if (totalActive >= this.config.execution.maxParallelTasks) {
      return false;
    }

    const agentConfig = this.config.agents[agentId];
    const maxAgentParallel = agentConfig?.maxParallel ?? 1;
    const currentAgentActive = this.agentActiveCounts.get(agentId) ?? 0;

    return currentAgentActive < maxAgentParallel;
  }

  canScheduleTeam(members: TeamMemberReservation[]): boolean {
    const allTaskIds = new Set<string>();
    for (const taskId of this.activeTasks.keys()) {
      allTaskIds.add(taskId);
    }
    for (const info of this.activeAssignments.values()) {
      allTaskIds.add(info.taskId);
    }
    for (const m of members) {
      allTaskIds.add(m.taskId);
    }

    const activeAssignmentsPerTask = new Map<string, number>();
    for (const [asgnId, info] of this.activeAssignments.entries()) {
      if (members.some((m) => m.assignmentId === asgnId)) {
        continue;
      }
      const cur = activeAssignmentsPerTask.get(info.taskId) ?? 0;
      activeAssignmentsPerTask.set(info.taskId, cur + 1);
    }

    const newMembersPerTask = new Map<string, number>();
    for (const m of members) {
      if (this.activeAssignments.has(m.assignmentId)) {
        continue;
      }
      const cur = newMembersPerTask.get(m.taskId) ?? 0;
      newMembersPerTask.set(m.taskId, cur + 1);
    }

    let projectedTotalSlots = 0;
    for (const taskId of allTaskIds) {
      const activeAsgns = activeAssignmentsPerTask.get(taskId) ?? 0;
      const newAsgns = newMembersPerTask.get(taskId) ?? 0;
      const totalForTask = activeAsgns + newAsgns;
      if (totalForTask > 0) {
        projectedTotalSlots += totalForTask;
      } else if (this.activeTasks.has(taskId)) {
        projectedTotalSlots += 1;
      }
    }

    if (projectedTotalSlots > this.config.execution.maxParallelTasks) {
      return false;
    }

    const requiredPerAgent = new Map<string, number>();
    for (const m of members) {
      if (this.activeAssignments.has(m.assignmentId)) {
        continue;
      }
      const taskAgent = this.activeTasks.get(m.taskId);
      if (taskAgent === m.agentId && !requiredPerAgent.has(m.agentId)) {
        requiredPerAgent.set(m.agentId, 0);
      } else {
        const cur = requiredPerAgent.get(m.agentId) ?? 0;
        requiredPerAgent.set(m.agentId, cur + 1);
      }
    }

    for (const [agentId, needed] of requiredPerAgent.entries()) {
      const agentConfig = this.config.agents[agentId];
      const maxAgentParallel = agentConfig?.maxParallel ?? 1;
      const currentAgentActive = this.agentActiveCounts.get(agentId) ?? 0;
      const heldByThisTask = members.some((m) => this.activeTasks.get(m.taskId) === agentId) ? 1 : 0;
      const activeByOthers = Math.max(0, currentAgentActive - heldByThisTask);
      const effectiveNeeded = Math.min(needed, Math.max(0, maxAgentParallel - heldByThisTask));
      if (activeByOthers + heldByThisTask + effectiveNeeded > maxAgentParallel) {
        return false;
      }
    }

    return true;
  }

  reserveTeam(members: TeamMemberReservation[]): void {
    for (const m of members) {
      this.acquire(m.assignmentId, m.agentId, m.taskId);
    }
  }

  releaseTeam(members: TeamMemberReservation[]): void {
    for (const m of members) {
      this.release(m.assignmentId, m.agentId, m.taskId);
    }
  }

  async waitForTeamSlots(
    members: TeamMemberReservation[],
    abortSignal?: AbortSignal,
    priority: number = 0,
    taskId?: string,
  ): Promise<void> {
    if (this.canScheduleTeam(members)) {
      this.reserveTeam(members);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiterId = randomUUID();

      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.removeWaiter(waiterId);
        reject(new Error('Aborted while waiting for team concurrency slots'));
      };

      const check = () => {
        if (settled) return true;
        if (this.canScheduleTeam(members)) {
          settled = true;
          abortSignal?.removeEventListener('abort', onAbort);
          this.reserveTeam(members);
          resolve();
          return true;
        }
        return false;
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          reject(new Error('Aborted while waiting for team concurrency slots'));
          return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiterSequence++;
      this.waiters.push({
        id: waiterId,
        priority,
        sequence: this.waiterSequence,
        taskId: taskId ?? members[0]?.taskId,
        check,
      });
    });
  }

  acquire(id: string, agentId: string, taskId?: string): void {
    if (this.activeAssignments.has(id)) {
      return;
    }

    // If id is a task (or taskId equals id)
    if (!taskId || id === taskId) {
      if (this.activeTasks.has(id)) {
        return;
      }
      this.activeTasks.set(id, agentId);
      const count = this.agentActiveCounts.get(agentId) ?? 0;
      this.agentActiveCounts.set(agentId, count + 1);
      return;
    }

    // It's an assignment: id = assignmentId, taskId = task.id
    // If the task already reserved a slot for this agent, associate it rather than double-counting
    const taskAgent = this.activeTasks.get(taskId);
    if (taskAgent === agentId) {
      this.activeAssignments.set(id, { agentId, taskId });
      return;
    }

    // Otherwise, this is a distinct team assignment (e.g. reviewer, partner, investigator)
    this.activeAssignments.set(id, { agentId, taskId });
    const count = this.agentActiveCounts.get(agentId) ?? 0;
    this.agentActiveCounts.set(agentId, count + 1);
  }

  release(id: string, agentId?: string, taskId?: string): void {
    if (this.activeAssignments.has(id)) {
      const asgnInfo = this.activeAssignments.get(id);
      this.activeAssignments.delete(id);

      const resolvedAgent = agentId ?? asgnInfo?.agentId;
      const resolvedTask = taskId ?? asgnInfo?.taskId;

      // If this assignment used the task-level reservation, outer task release will handle agentActiveCounts
      if (resolvedTask && this.activeTasks.get(resolvedTask) === resolvedAgent) {
        this.notifyWaiters();
        return;
      }

      if (resolvedAgent) {
        const count = this.agentActiveCounts.get(resolvedAgent) ?? 0;
        if (count > 0) {
          this.agentActiveCounts.set(resolvedAgent, count - 1);
        }
      }
      this.notifyWaiters();
      return;
    }

    // Otherwise releasing a task
    const recordedAgent = agentId ?? this.activeTasks.get(id);
    this.activeTasks.delete(id);
    if (recordedAgent) {
      const count = this.agentActiveCounts.get(recordedAgent) ?? 0;
      if (count > 0) {
        this.agentActiveCounts.set(recordedAgent, count - 1);
      }
    }
    this.notifyWaiters();
  }

  async waitForSlot(
    agentId: string,
    taskId?: string,
    abortSignal?: AbortSignal,
    assignmentId?: string,
    priority: number = 0,
  ): Promise<void> {
    if (assignmentId && this.activeAssignments.has(assignmentId)) {
      return;
    }

    if (taskId && this.activeTasks.get(taskId) === agentId) {
      return;
    }

    if (this.canSchedule(agentId)) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiterId = randomUUID();

      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.removeWaiter(waiterId);
        reject(new Error('Aborted while waiting for concurrency slot'));
      };

      const check = () => {
        if (settled) return true;
        if (
          (assignmentId && this.activeAssignments.has(assignmentId)) ||
          (taskId && this.activeTasks.get(taskId) === agentId)
        ) {
          settled = true;
          abortSignal?.removeEventListener('abort', onAbort);
          resolve();
          return true;
        }
        if (this.canSchedule(agentId)) {
          settled = true;
          abortSignal?.removeEventListener('abort', onAbort);
          if (assignmentId || taskId) {
            this.acquire(assignmentId ?? taskId!, agentId, taskId);
          }
          resolve();
          return true;
        }
        return false;
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          reject(new Error('Aborted while waiting for concurrency slot'));
          return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiterSequence++;
      this.waiters.push({
        id: waiterId,
        priority,
        sequence: this.waiterSequence,
        taskId,
        check,
      });
    });
  }

  private removeWaiter(waiterId: string): void {
    const idx = this.waiters.findIndex((w) => w.id === waiterId);
    if (idx !== -1) {
      this.waiters.splice(idx, 1);
    }
  }

  private notifyWaiters(): void {
    // Sort waiters in descending order of priority; tie-break by sequence (FIFO)
    this.waiters.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.sequence - b.sequence;
    });

    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      if (waiter.check()) {
        this.waiters.splice(i, 1);
        i--;
      }
    }
  }

  getWaitingCount(): number {
    return this.waiters.length;
  }

  getWaiters(): Array<{ id: string; priority: number; sequence: number; taskId?: string }> {
    return this.waiters.map((w) => ({
      id: w.id,
      priority: w.priority,
      sequence: w.sequence,
      taskId: w.taskId,
    }));
  }

  getActiveCount(): number {
    return Math.max(this.activeTasks.size, this.activeAssignments.size);
  }

  getActiveAssignmentCount(): number {
    return this.activeAssignments.size;
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  getAgentActiveCount(agentId: string): number {
    return this.agentActiveCounts.get(agentId) ?? 0;
  }
}
