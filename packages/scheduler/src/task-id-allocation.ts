import { Task, TaskGraph } from '@taskforge/core';

/**
 * Task rows are keyed by task id alone, but planners number tasks TASK-01,
 * TASK-02, ... in every run. Persisting a second run would overwrite the
 * first run's tasks (and cascade-delete its assignments), destroying history
 * and making `tf resume` of the earlier run impossible.
 *
 * When any id of the new graph is already taken by an earlier run, the whole
 * graph is renumbered to ids no run has used, keeping the TASK-NN shape that
 * slash commands and logs rely on. Graphs without a clash are left untouched.
 */

export interface TaskIdAllocator {
  isTaken(id: string): boolean;
  /** Highest N among existing ids shaped like TASK-N. */
  maxNumericId(): number;
}

const NUMBERED = /^TASK-(\d+)$/;

export function planTaskIdRemap(
  graph: TaskGraph,
  allocator: TaskIdAllocator,
  runId: string,
): Map<string, string> | undefined {
  const tasks = graph.getAllTasks();
  if (!tasks.some((task) => allocator.isTaken(task.id))) return undefined;

  const mapping = new Map<string, string>();
  const used = new Set<string>();
  let next = allocator.maxNumericId();
  const suffix = runId.replace(/^run-/, '').slice(-6);

  for (const task of tasks) {
    const numbered = NUMBERED.exec(task.id);
    let candidate: string;
    if (numbered) {
      do {
        next++;
        candidate = `TASK-${String(next).padStart(Math.max(2, numbered[1].length), '0')}`;
      } while (allocator.isTaken(candidate) || used.has(candidate));
    } else {
      candidate = `${task.id}-${suffix}`;
      for (let n = 2; allocator.isTaken(candidate) || used.has(candidate); n++) {
        candidate = `${task.id}-${suffix}-${n}`;
      }
    }
    used.add(candidate);
    mapping.set(task.id, candidate);
  }
  return mapping;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrites whole-token occurrences of old ids inside any string, recursively. */
function remapValue<T>(value: T, mapping: Map<string, string>, pattern: RegExp): T {
  if (typeof value === 'string') {
    return value.replace(pattern, (match) => mapping.get(match) ?? match) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapValue(item, mapping, pattern)) as unknown as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = remapValue(item, mapping, pattern);
    }
    return out as T;
  }
  return value;
}

export function applyTaskIdRemap(graph: TaskGraph, mapping: Map<string, string>): TaskGraph {
  const oldIds = [...mapping.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![\\w-])(?:${oldIds.map(escapeRegExp).join('|')})(?![\\w-])`, 'g');
  const tasks: Task[] = graph.getAllTasks().map((task) => {
    const renamed = remapValue(task, mapping, pattern) as Task;
    return { ...renamed, id: mapping.get(task.id) ?? task.id };
  });
  const metadata = graph.metadata ? remapValue(graph.metadata, mapping, pattern) : undefined;
  return new TaskGraph(tasks, metadata);
}
