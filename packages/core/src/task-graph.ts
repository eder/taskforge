import { InvalidTaskGraphError, TaskStatus } from '@taskforge/shared';
import { Task, TaskStateMachine } from './models.js';

export class TaskGraph {
  private tasks: Map<string, Task> = new Map();
  public metadata?: Record<string, any>;

  constructor(tasks: Task[] = [], metadata?: Record<string, any>) {
    this.metadata = metadata;
    for (const task of tasks) {
      this.addTask(task);
    }
    this.validate();
  }

  addTask(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new InvalidTaskGraphError(`Task with id ${task.id} already exists in graph`, {
        taskId: task.id,
      });
    }
    this.tasks.set(task.id, { ...task });
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  updateTaskStatus(taskId: string, newStatus: TaskStatus): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new InvalidTaskGraphError(`Cannot update status: Task ${taskId} not found in graph`, {
        taskId,
      });
    }

    const updated = TaskStateMachine.transition(task, newStatus);
    this.tasks.set(taskId, updated);
    return updated;
  }

  validate(): void {
    // 1. Verify all dependencies exist in the graph
    for (const task of this.tasks.values()) {
      for (const depId of task.dependencies) {
        if (!this.tasks.has(depId)) {
          throw new InvalidTaskGraphError(
            `Task ${task.id} has unknown dependency '${depId}' which does not exist in graph`,
            { taskId: task.id, missingDependency: depId },
          );
        }
      }
    }

    // 2. Cycle detection via DFS (white, gray, black coloring)
    const visited = new Map<string, 'WHITE' | 'GRAY' | 'BLACK'>();
    for (const id of this.tasks.keys()) {
      visited.set(id, 'WHITE');
    }

    const dfs = (nodeId: string, path: string[]) => {
      visited.set(nodeId, 'GRAY');
      const task = this.tasks.get(nodeId)!;

      for (const depId of task.dependencies) {
        const state = visited.get(depId);
        if (state === 'GRAY') {
          throw new InvalidTaskGraphError(
            `Cycle detected in task graph: ${[...path, nodeId, depId].join(' -> ')}`,
            { cyclePath: [...path, nodeId, depId] },
          );
        }
        if (state === 'WHITE') {
          dfs(depId, [...path, nodeId]);
        }
      }

      visited.set(nodeId, 'BLACK');
    };

    for (const id of this.tasks.keys()) {
      if (visited.get(id) === 'WHITE') {
        dfs(id, []);
      }
    }
  }

  topologicalSort(): Task[] {
    return this.getTopologicalOrder();
  }

  getTopologicalOrder(): Task[] {
    this.validate();

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const id of this.tasks.keys()) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }

    for (const task of this.tasks.values()) {
      inDegree.set(task.id, task.dependencies.length);
      for (const depId of task.dependencies) {
        dependents.get(depId)?.push(task.id);
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    const result: Task[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      result.push(this.tasks.get(currentId)!);

      for (const dependentId of dependents.get(currentId) ?? []) {
        const newDegree = (inDegree.get(dependentId) ?? 1) - 1;
        inDegree.set(dependentId, newDegree);
        if (newDegree === 0) {
          queue.push(dependentId);
        }
      }
    }

    return result;
  }

  getRunnableTasks(): Task[] {
    const runnable: Task[] = [];

    for (const task of this.tasks.values()) {
      // Must be in accepted or ready state to become runnable
      if (task.status !== 'accepted' && task.status !== 'ready') {
        continue;
      }

      // Every declared dependency must be verified or integrated
      const allDepsSatisfied = task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep && (dep.status === 'verified' || dep.status === 'integrated');
      });

      if (allDepsSatisfied) {
        runnable.push(task);
      }
    }

    return runnable;
  }

  isAllCompleted(): boolean {
    if (this.tasks.size === 0) return true;
    for (const task of this.tasks.values()) {
      if (task.status !== 'integrated') {
        return false;
      }
    }
    return true;
  }

  hasFailuresOrBlocks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'failed' || task.status === 'blocked') {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns all tasks in the graph that directly list taskId in their dependencies.
   */
  getDirectDependents(taskId: string): Task[] {
    const dependents: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.dependencies.includes(taskId)) {
        dependents.push(task);
      }
    }
    return dependents;
  }

  /**
   * Returns all tasks in the graph that directly or transitively depend on taskId.
   */
  getTransitiveDependents(taskId: string): Task[] {
    const result = new Set<string>();
    const queue = [taskId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const task of this.tasks.values()) {
        if (task.dependencies.includes(current) && !result.has(task.id)) {
          result.add(task.id);
          queue.push(task.id);
        }
      }
    }
    return Array.from(result).map((id) => this.tasks.get(id)!);
  }
}
