import { TaskForgeConfig } from '@taskforge/shared';

export class ConcurrencyManager {
  private activeTasks: Set<string> = new Set();
  private agentActiveCounts: Map<string, number> = new Map();

  constructor(private config: TaskForgeConfig) {}

  canSchedule(agentId: string): boolean {
    if (this.activeTasks.size >= this.config.execution.maxParallelTasks) {
      return false;
    }

    const agentConfig = this.config.agents[agentId];
    const maxAgentParallel = agentConfig?.maxParallel ?? 1;
    const currentAgentActive = this.agentActiveCounts.get(agentId) ?? 0;

    return currentAgentActive < maxAgentParallel;
  }

  acquire(taskId: string, agentId: string): void {
    this.activeTasks.add(taskId);
    const count = this.agentActiveCounts.get(agentId) ?? 0;
    this.agentActiveCounts.set(agentId, count + 1);
  }

  release(taskId: string, agentId: string): void {
    this.activeTasks.delete(taskId);
    const count = this.agentActiveCounts.get(agentId) ?? 0;
    if (count > 0) {
      this.agentActiveCounts.set(agentId, count - 1);
    }
  }

  getActiveCount(): number {
    return this.activeTasks.size;
  }
}
