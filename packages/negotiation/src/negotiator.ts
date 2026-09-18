import { randomUUID } from 'node:crypto';
import {
  TaskPreflightResult,
  TaskNegotiationError,
} from '@taskforge/shared';
import { Task, TaskGraph } from '@taskforge/core';
import { EventRepository, TaskForgeDatabase } from '@taskforge/persistence';
import { AgentAdapter } from '@taskforge/agents';

export interface PreflightEvaluator {
  evaluate(task: Task, agent?: AgentAdapter): Promise<TaskPreflightResult>;
}

export class DefaultPreflightEvaluator implements PreflightEvaluator {
  async evaluate(task: Task): Promise<TaskPreflightResult> {
    // Default safe preflight acceptance
    return {
      decision: 'accept',
      understanding: `Understood task objective: ${task.contract.objective}`,
      concerns: [],
      missingContext: [],
      suggestedDependencies: [],
    };
  }
}

export class NegotiationManager {
  constructor(
    private evaluator: PreflightEvaluator = new DefaultPreflightEvaluator(),
    private eventRepo?: EventRepository,
    private db?: TaskForgeDatabase,
  ) {}

  async runPreflight(
    task: Task,
    runId: string,
    agent?: AgentAdapter,
  ): Promise<TaskPreflightResult> {
    if (this.eventRepo) {
      this.eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: task.id,
        type: 'TASK_PREFLIGHT_STARTED',
        payload: { objective: task.contract.objective, agentId: agent?.id },
        timestamp: new Date(),
      });
    }

    const preflight = await this.evaluator.evaluate(task, agent);

    if (this.db) {
      const now = new Date().toISOString();
      // Ensure parent task exists in tasks table before inserting preflight record
      this.db
        .prepare(
          `INSERT OR IGNORE INTO tasks (
            id, run_id, goal_id, title, description, type, status,
            contract_json, rework_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          runId,
          task.goalId || 'goal-default',
          task.title,
          task.description,
          task.type,
          task.status,
          JSON.stringify(task.contract),
          task.reworkCount ?? 0,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO preflight_results (
            id, run_id, task_id, decision, understanding,
            concerns_json, missing_context_json, suggested_dependencies_json,
            collaboration_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `pf-${randomUUID()}`,
          runId,
          task.id,
          preflight.decision,
          preflight.understanding,
          JSON.stringify(preflight.concerns),
          JSON.stringify(preflight.missingContext),
          JSON.stringify(preflight.suggestedDependencies),
          preflight.collaboration ? JSON.stringify(preflight.collaboration) : null,
          now,
        );
    }

    if (preflight.decision === 'challenge') {
      if (this.eventRepo) {
        this.eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'TASK_CHALLENGED',
          payload: {
            concerns: preflight.concerns,
            suggestedDependencies: preflight.suggestedDependencies,
          },
          timestamp: new Date(),
        });
      }
    }

    return preflight;
  }

  async negotiateGraph(graph: TaskGraph, runId: string): Promise<TaskGraph> {
    const tasks = graph.getAllTasks();

    for (const task of tasks) {
      if (task.status !== 'proposed') continue;

      graph.updateTaskStatus(task.id, 'preflight');
      const preflight = await this.runPreflight(task, runId);

      if (preflight.decision === 'accept') {
        graph.updateTaskStatus(task.id, 'accepted');
        if (this.eventRepo) {
          this.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'TASK_ACCEPTED',
            payload: { understanding: preflight.understanding },
            timestamp: new Date(),
          });
        }
      } else if (preflight.decision === 'challenge' || preflight.decision === 'need_dependency') {
        graph.updateTaskStatus(task.id, 'negotiating');

        // Apply suggested dependencies
        if (preflight.suggestedDependencies.length > 0) {
          for (const dep of preflight.suggestedDependencies) {
            if (!task.dependencies.includes(dep) && graph.getTask(dep)) {
              task.dependencies.push(dep);
            }
          }
        }

        // Apply any context constraints
        if (preflight.concerns.length > 0) {
          task.contract.forbiddenChanges.push(...preflight.concerns);
        }

        graph.updateTaskStatus(task.id, 'accepted');
        if (this.eventRepo) {
          this.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'TASK_ACCEPTED',
            payload: {
              understanding: preflight.understanding,
              negotiated: true,
            },
            timestamp: new Date(),
          });
        }
      } else if (preflight.decision === 'recommend_merge') {
        graph.updateTaskStatus(task.id, 'negotiating');
        // Merging tasks into one
        graph.updateTaskStatus(task.id, 'accepted');
      } else {
        throw new TaskNegotiationError(
          `Task preflight rejected with decision: ${preflight.decision}`,
          { taskId: task.id, preflight },
        );
      }
    }

    return graph;
  }
}
