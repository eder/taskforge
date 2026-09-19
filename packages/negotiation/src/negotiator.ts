import { randomUUID } from 'node:crypto';
import { TaskPreflightResult, TaskNegotiationError } from '@taskforge/shared';
import { Task, TaskGraph } from '@taskforge/core';
import { EventRepository, TaskForgeDatabase } from '@taskforge/persistence';
import { AgentAdapter } from '@taskforge/agents';

export interface PreflightEvaluator {
  evaluate(task: Task, agent?: AgentAdapter): Promise<TaskPreflightResult>;
}

export interface AgentPreflightOptions {
  evaluateWorkerFn?: (task: Task, agent: AgentAdapter) => Promise<TaskPreflightResult>;
}

export class AgentPreflightEvaluator implements PreflightEvaluator {
  constructor(private options: AgentPreflightOptions = {}) {}

  async evaluate(task: Task, agent?: AgentAdapter): Promise<TaskPreflightResult> {
    if (this.options.evaluateWorkerFn && agent) {
      return this.options.evaluateWorkerFn(task, agent);
    }

    if (agent && typeof (agent as any).preflight === 'function') {
      return (agent as any).preflight(task);
    }

    const contract = task.contract;
    const missingContext: string[] = [];
    const concerns: string[] = [];
    const suggestedDependencies: string[] = [];

    // Check 1: Missing acceptance criteria
    if (!contract.acceptanceCriteria || contract.acceptanceCriteria.length === 0) {
      missingContext.push('Acceptance criteria are missing or empty');
    }

    // Check 2: Missing objective
    if (!contract.objective || contract.objective.trim().length === 0) {
      missingContext.push('Contract objective is undefined');
    }

    // If critical context is missing, return 'need_context'
    if (missingContext.length > 0) {
      return {
        decision: 'need_context',
        understanding: `Insufficient context to safely execute task ${task.id}`,
        concerns: ['Cannot determine completion without acceptance criteria or objective'],
        missingContext,
        suggestedDependencies,
      };
    }

    // Check 3: Agent capabilities compatibility if agent provided
    if (agent) {
      const caps = await agent.capabilities();
      if (task.type === 'implementation' && !caps.canWrite) {
        concerns.push(`Assigned agent ${agent.name} does not possess write capabilities`);
        return {
          decision: 'challenge',
          understanding: `Task requires code edits but agent ${agent.name} is read-only`,
          concerns,
          missingContext: [],
          suggestedDependencies,
        };
      }
    }

    // Check 4: Unbounded scope for refactor / cross-cutting architecture tasks -> recommend collaboration
    const isUnboundedScope =
      contract.allowedScope.length === 0 ||
      contract.allowedScope.includes('*') ||
      contract.allowedScope.includes('**/*');

    if (
      (task.type === 'refactoring' || task.type === 'architecture') &&
      isUnboundedScope &&
      task.description.toLowerCase().includes('architecture')
    ) {
      return {
        decision: 'recommend_collaboration',
        understanding: `Cross-cutting architecture overhaul requires collaborative review and verification`,
        concerns: ['Scope is unbounded across entire repository for an architecture refactor'],
        missingContext: [],
        suggestedDependencies,
        collaboration: {
          reason: 'Unbounded architecture refactor requires pairing with architecture reviewer',
          requestedRoles: ['implementer', 'architecture_reviewer'],
          expectedBenefit: 'Avoid unintended regression across repository modules',
          urgency: 'high',
        },
      };
    }

    // Check 5: Implicit dependency detection (e.g. integration test without prerequisites)
    if (
      task.dependencies.length === 0 &&
      task.description.toLowerCase().includes('integration test')
    ) {
      suggestedDependencies.push('TASK-IMPL');
      return {
        decision: 'need_dependency',
        understanding: `Integration test requires underlying implementation before execution`,
        concerns: ['No prerequisites specified for integration testing task'],
        missingContext: [],
        suggestedDependencies,
      };
    }

    // Default: accept
    return {
      decision: 'accept',
      understanding: `Understood and validated objective: "${contract.objective}"`,
      concerns: [],
      missingContext: [],
      suggestedDependencies: [],
    };
  }
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
    private evaluator: PreflightEvaluator = new AgentPreflightEvaluator(),
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
      } else if (preflight.decision === 'recommend_collaboration') {
        graph.updateTaskStatus(task.id, 'negotiating');
        if (preflight.collaboration) {
          task.contract.metadata = {
            ...task.contract.metadata,
            recommendCollaboration: true,
            collaboration: preflight.collaboration,
          };
        }
        graph.updateTaskStatus(task.id, 'accepted');
        if (this.eventRepo) {
          this.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'TASK_COLLABORATION_RECOMMENDED',
            payload: {
              understanding: preflight.understanding,
              collaboration: preflight.collaboration,
            },
            timestamp: new Date(),
          });
        }
      } else if (preflight.decision === 'recommend_split') {
        graph.updateTaskStatus(task.id, 'negotiating');
        graph.updateTaskStatus(task.id, 'accepted');
        if (this.eventRepo) {
          this.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'TASK_SPLIT_RECOMMENDED',
            payload: { understanding: preflight.understanding },
            timestamp: new Date(),
          });
        }
      } else if (preflight.decision === 'need_context') {
        graph.updateTaskStatus(task.id, 'negotiating');
        if (preflight.missingContext.length > 0) {
          task.contract.forbiddenChanges.push(...preflight.missingContext);
        }
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
