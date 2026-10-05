import { Task, TaskGraph } from '@taskforge/core';
import { taskProducesChanges } from './dual-review.js';

/**
 * Parallelism of a plan.
 *
 * Tasks that do not depend on each other run at the same time, each in its own
 * worktree, and their commits are integrated one after the other. That is safe
 * when they change different files and a source of integration conflicts when
 * they change the same ones. The planner is asked to split work only along
 * files; this module is the deterministic check behind that request: two
 * mutating tasks that could run together and may write the same files are made
 * to run one after the other.
 */

function normalize(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** The part of a pattern before its first wildcard, cut at a directory boundary. */
function staticPrefix(scope: string): string | undefined {
  const pattern = normalize(scope);
  if (pattern === '' || pattern === '*' || pattern === '**') return undefined;
  const wildcard = pattern.search(/[*?[{]/);
  if (wildcard === -1) return pattern;
  const head = pattern.slice(0, wildcard);
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/')) : '';
}

function prefixesRelated(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Whether two sets of writable patterns may reach the same file. Conservative:
 * an empty or repository-wide scope overlaps everything, and patterns are
 * compared by the directory they start in.
 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const left of a) {
    const leftPrefix = staticPrefix(left);
    if (leftPrefix === undefined) return true;
    for (const right of b) {
      const rightPrefix = staticPrefix(right);
      if (rightPrefix === undefined) return true;
      if (prefixesRelated(leftPrefix, rightPrefix)) return true;
    }
  }
  return false;
}

export interface AddedDependency {
  taskId: string;
  after: string;
}

function ancestorsOf(taskId: string, byId: Map<string, string[]>): Set<string> {
  const found = new Set<string>();
  const stack = [...(byId.get(taskId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    stack.push(...(byId.get(id) ?? []));
  }
  return found;
}

/**
 * The dependencies to add so no two tasks that change files, and that nothing
 * orders yet, may write the same files at the same time. `ordered` lists the
 * tasks with prerequisites first.
 */
export function dependenciesToSerialize(ordered: readonly Task[]): AddedDependency[] {
  const dependencies = new Map(ordered.map((task) => [task.id, [...task.dependencies]]));
  const writers = ordered.filter(taskProducesChanges);
  const added: AddedDependency[] = [];

  for (let later = 1; later < writers.length; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      const first = writers[earlier];
      const second = writers[later];
      if (ancestorsOf(second.id, dependencies).has(first.id)) continue;
      if (ancestorsOf(first.id, dependencies).has(second.id)) continue;
      if (!scopesOverlap(first.contract.allowedScope ?? [], second.contract.allowedScope ?? [])) {
        continue;
      }
      dependencies.get(second.id)!.push(first.id);
      added.push({ taskId: second.id, after: first.id });
    }
  }
  return added;
}

/** Applies `dependenciesToSerialize` to a graph and returns what was added. */
export function serializeOverlappingTasks(graph: TaskGraph): AddedDependency[] {
  const added = dependenciesToSerialize(graph.topologicalSort());
  for (const { taskId, after } of added) {
    const task = graph.getTask(taskId);
    if (!task) continue;
    if (!task.dependencies.includes(after)) task.dependencies.push(after);
    task.contract.dependencies = Array.from(new Set([...(task.contract.dependencies ?? []), after]));
  }
  if (added.length > 0) graph.validate();
  return added;
}

/**
 * The most tasks that can be running together once overlapping ones are ordered:
 * the widest layer of the plan, where a task sits one layer below the deepest
 * task it waits for.
 */
export function planWidth(tasks: readonly Task[]): number {
  const extra = dependenciesToSerialize(tasks);
  const dependencies = new Map(tasks.map((task) => [task.id, [...task.dependencies]]));
  for (const { taskId, after } of extra) dependencies.get(taskId)?.push(after);

  const depth = new Map<string, number>();
  const depthOf = (id: string, trail: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    trail.add(id);
    const level =
      1 + Math.max(0, ...(dependencies.get(id) ?? []).map((dep) => depthOf(dep, trail)));
    trail.delete(id);
    depth.set(id, level);
    return level;
  };
  const sizes = new Map<number, number>();
  for (const task of tasks) {
    const level = depthOf(task.id, new Set());
    sizes.set(level, (sizes.get(level) ?? 0) + 1);
  }
  return Math.max(0, ...sizes.values());
}
