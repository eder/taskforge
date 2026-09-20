import { Task } from './models.js';
import { TaskGraph } from './task-graph.js';

export interface TaskPriorityFactors {
  downstreamCount: number;
  downstreamScore: number;
  explicitPriority: number;
  criticalityScore: number;
  reworkScore: number;
  typeScore: number;
  total: number;
}

/**
 * Calculates a comprehensive priority score for a task to drive dynamic concurrency slot prioritization.
 *
 * Scoring factors:
 * 1. Dependency-blocking: Each transitive downstream task waiting on this task adds 10 points.
 * 2. Criticality/Risk: High/critical risk or priority in task contract metadata adds 30-90 points.
 * 3. Explicit priority: Explicit task.priority or metadata.priority number directly adds to the score.
 * 4. Rework cycles: Tasks in retry/rework cycles receive bonus points (15-45) to prevent stalling the pipeline.
 * 5. Architecture tasks: Foundational architecture tasks receive 15 points.
 */
export function computeTaskPriority(task: Task, graph?: TaskGraph): number {
  return calculateTaskPriorityFactors(task, graph).total;
}

export function calculateTaskPriorityFactors(task: Task, graph?: TaskGraph): TaskPriorityFactors {
  // 1. Dependency-blocking weight: transitive downstream dependents
  let downstreamCount = 0;
  if (graph) {
    downstreamCount = graph.getTransitiveDependents(task.id).length;
  }
  const downstreamScore = downstreamCount * 10;

  // 2. Explicit task priority
  let explicitPriority = 0;
  if (typeof task.priority === 'number') {
    explicitPriority = task.priority;
  }

  // 3. Criticality / Risk metadata
  let criticalityScore = 0;
  const meta = task.contract?.metadata;
  if (meta) {
    if (typeof meta.priority === 'number') {
      explicitPriority = Math.max(explicitPriority, meta.priority);
    } else if (typeof meta.priority === 'string') {
      switch (meta.priority.toLowerCase()) {
        case 'critical':
        case 'urgent':
          criticalityScore += 50;
          break;
        case 'high':
          criticalityScore += 30;
          break;
        case 'medium':
        case 'normal':
          criticalityScore += 10;
          break;
        case 'low':
          criticalityScore += 0;
          break;
      }
    }

    if (
      meta.critical === true ||
      meta.criticality === 'critical' ||
      meta.risk === 'high' ||
      meta.risk === 'critical'
    ) {
      criticalityScore += 40;
    } else if (meta.risk === 'medium' || meta.criticality === 'high') {
      criticalityScore += 20;
    }
  }

  // 4. Rework / Retry prioritization
  let reworkScore = 0;
  if (task.reworkCount > 0) {
    reworkScore = Math.min(task.reworkCount * 15, 45);
  }

  // 5. Architecture tasks establish foundational interfaces
  let typeScore = 0;
  if (task.type === 'architecture') {
    typeScore = 15;
  }

  const total = downstreamScore + explicitPriority + criticalityScore + reworkScore + typeScore;

  return {
    downstreamCount,
    downstreamScore,
    explicitPriority,
    criticalityScore,
    reworkScore,
    typeScore,
    total,
  };
}
