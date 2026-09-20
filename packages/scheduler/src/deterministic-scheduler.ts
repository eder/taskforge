import { randomUUID } from 'node:crypto';
import { AgentAssignment, AgentUnavailableError, TaskForgeConfig } from '@taskforge/shared';
import { TaskGraph, Task } from '@taskforge/core';
import { AgentRegistry, AgentActivityTracker } from '@taskforge/agents';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import {
  AssignmentRepository,
  EventRepository,
  ExecutionRepository,
  RunRepository,
  TaskRepository,
  WorkspaceRepository,
} from '@taskforge/persistence';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { NegotiationManager } from '@taskforge/negotiation';
import { CommunicationBus, EscalationHandler } from '@taskforge/collaboration';
import { InteractionGateway } from '@taskforge/execution';
import { ConcurrencyManager } from './concurrency-manager.js';
import { executeGovernedAssignment } from './governed-assignment.js';

export interface SchedulerContext {
  runId: string;
  baseCommit: string;
  repoRoot: string;
  config: TaskForgeConfig;
  graph: TaskGraph;
  agentRegistry: AgentRegistry;
  worktreeManager: WorktreeManager;
  gitService: GitService;
  verificationRunner: VerificationRunner;
  integrationService: IntegrationService;
  runRepo: RunRepository;
  taskRepo: TaskRepository;
  assignmentRepo: AssignmentRepository;
  executionRepo: ExecutionRepository;
  eventRepo: EventRepository;
  workspaceRepo: WorkspaceRepository;
  interactionGateway?: InteractionGateway;
  activityTracker?: AgentActivityTracker;
  preferredAgentMapping?: Record<string, string>;
  abortSignal?: AbortSignal;
  negotiator?: NegotiationManager;
  communicationBus?: CommunicationBus;
  escalationHandler?: EscalationHandler;
  onProgress?: (message: string) => void;
  collaborativeExecutors?: Map<
    string,
    (task: Task, ctx: SchedulerContext) => Promise<{ success: boolean; commitHash?: string }>
  >;
}

export interface SchedulerResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  tasksCompleted: number;
  tasksFailed: number;
  integrationBranch?: string;
  taskOutputs?: Record<string, string>;
  error?: string;
}

export class DeterministicScheduler {
  private concurrency: ConcurrencyManager;
  private taskOutputs: Record<string, string> = {};
  private hasIntegratedCommits = false;
  private failedAgentsByTask = new Map<string, Set<string>>();

  constructor(private ctx: SchedulerContext) {
    this.concurrency = new ConcurrencyManager(ctx.config);
  }

  private resolveAgentId(task: Task): string {
    const failed = this.failedAgentsByTask.get(task.id) ?? new Set<string>();

    if (this.ctx.preferredAgentMapping && this.ctx.preferredAgentMapping[task.id]) {
      const preferred = this.ctx.preferredAgentMapping[task.id];
      if (!failed.has(preferred)) {
        return preferred;
      }
    }
    const configuredAgent = this.ctx.config.planner.agent;
    if (
      configuredAgent &&
      this.ctx.agentRegistry.get(configuredAgent) &&
      !failed.has(configuredAgent)
    ) {
      return configuredAgent;
    }
    const registered = this.ctx.agentRegistry.list();
    const available = registered.filter((a) => !failed.has(a.id));
    if (available.length > 0) {
      return available[0].id;
    }
    if (registered.length > 0) {
      return registered[0].id;
    }
    return 'codex';
  }

  async run(): Promise<SchedulerResult> {
    this.hasIntegratedCommits = false;
    const { runId, graph, eventRepo, runRepo, abortSignal, baseCommit } = this.ctx;

    eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'TASK_STARTED',
      payload: { message: 'Deterministic scheduler initiated' },
      timestamp: new Date(),
    });

    // Main scheduling loop
    const runningPromises = new Map<string, Promise<void>>();

    while (!graph.isAllCompleted() && !graph.hasFailuresOrBlocks()) {
      if (abortSignal?.aborted) {
        runRepo.updateStatus(runId, 'cancelled');
        return {
          runId,
          status: 'cancelled',
          tasksCompleted: graph.getAllTasks().filter((t) => t.status === 'integrated').length,
          tasksFailed: 0,
        };
      }

      const runnableTasks = graph.getRunnableTasks();

      // Filter out tasks currently running
      const candidates = runnableTasks.filter((t) => !runningPromises.has(t.id));

      if (candidates.length === 0 && runningPromises.size === 0) {
        // No candidates and nothing running, but not all completed -> deadlock or blocked
        break;
      }

      for (const task of candidates) {
        const agentId = this.resolveAgentId(task);
        if (this.concurrency.canSchedule(agentId)) {
          this.concurrency.acquire(task.id, agentId);

          const taskPromise = this.executeTask(task, agentId).finally(() => {
            this.concurrency.release(task.id, agentId);
            runningPromises.delete(task.id);
          });

          runningPromises.set(task.id, taskPromise);
        }
      }

      if (runningPromises.size > 0) {
        // Wait for at least one active task to complete before next scheduling cycle
        await Promise.race(runningPromises.values());
      } else {
        // Small yield
        await new Promise((res) => setTimeout(res, 50));
      }
    }

    // Await any remaining active running tasks
    if (runningPromises.size > 0) {
      await Promise.all(runningPromises.values());
    }

    const tasks = graph.getAllTasks();
    const tasksCompleted = tasks.filter((t) => t.status === 'integrated').length;
    const tasksFailed = tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').length;

    let status: 'completed' | 'failed' =
      tasksFailed === 0 && graph.isAllCompleted() ? 'completed' : 'failed';
    let integrationBranch: string | undefined;
    let errorMessage: string | undefined;

    if (status === 'completed' && this.hasIntegratedCommits) {
      try {
        const final = await this.ctx.integrationService.finalizeRun(
          runId,
          this.ctx.config,
          baseCommit,
        );
        integrationBranch = final.branchName;
      } catch (err) {
        status = 'failed';
        errorMessage = (err as Error).message;
        this.ctx.onProgress?.(`Final integration error: ${(err as Error).message}`);
      }
    } else if (status === 'completed' && !this.hasIntegratedCommits) {
      integrationBranch = undefined;
    } else {
      errorMessage = `Tasks not all integrated: completed=${tasksCompleted}, failed=${tasksFailed}, allCompleted=${graph.isAllCompleted()}`;
    }

    runRepo.updateStatus(runId, status);
    await this.ctx.worktreeManager.prune().catch(() => {});

    return {
      runId,
      status,
      tasksCompleted,
      tasksFailed,
      integrationBranch,
      taskOutputs: this.taskOutputs,
      error: errorMessage,
    };
  }

  private async executeTask(task: Task, agentId: string): Promise<void> {
    const {
      runId,
      graph,
      agentRegistry,
      worktreeManager,
      taskRepo,
      assignmentRepo,
      executionRepo,
      workspaceRepo,
      eventRepo,
      verificationRunner,
      integrationService,
      config,
      baseCommit,
      abortSignal,
    } = this.ctx;

    const agent = agentRegistry.get(agentId);
    if (!agent) {
      throw new AgentUnavailableError(`Agent ${agentId} not found in registry`, {
        agentId,
        taskId: task.id,
      });
    }

    // Preflight negotiation if negotiator provided
    if (this.ctx.negotiator && (task.status === 'proposed' || task.status === 'accepted')) {
      graph.updateTaskStatus(task.id, 'preflight');
      taskRepo.updateStatus(task.id, 'preflight');
      const pf = await this.ctx.negotiator.runPreflight(task, runId, agent);
      if (pf.decision === 'challenge' || pf.decision === 'need_dependency') {
        graph.updateTaskStatus(task.id, 'negotiating');
        taskRepo.updateStatus(task.id, 'negotiating');
        if (pf.suggestedDependencies?.length > 0) {
          for (const dep of pf.suggestedDependencies) {
            if (!task.dependencies.includes(dep) && graph.getTask(dep)) {
              task.dependencies.push(dep);
            }
          }
        }
        if (pf.concerns?.length > 0) {
          task.contract.forbiddenChanges.push(...pf.concerns);
        }
        graph.updateTaskStatus(task.id, 'accepted');
        taskRepo.updateStatus(task.id, 'accepted');
      } else if (pf.decision === 'recommend_collaboration') {
        graph.updateTaskStatus(task.id, 'negotiating');
        taskRepo.updateStatus(task.id, 'negotiating');
        if (pf.collaboration) {
          task.contract.metadata = {
            ...task.contract.metadata,
            recommendCollaboration: true,
            collaboration: pf.collaboration,
          };
        }
        if (pf.concerns?.length > 0) {
          task.contract.forbiddenChanges.push(...pf.concerns);
        }
        graph.updateTaskStatus(task.id, 'accepted');
        taskRepo.updateStatus(task.id, 'accepted');
      } else if (pf.decision === 'accept') {
        graph.updateTaskStatus(task.id, 'accepted');
        taskRepo.updateStatus(task.id, 'accepted');
      }
    }

    // Check for collaborative execution override
    if (this.ctx.collaborativeExecutors?.has(task.id)) {
      this.ctx.activityTracker?.register({
        taskId: task.id,
        assignmentId: `asgn-${task.id}-collab`,
        taskTitle: task.title,
        agentId: 'collaborative',
        agentName: 'Collaborative Pair',
        role: 'implementer',
        status: 'Collaborative execution running...',
        startedAt: new Date(),
        lastActiveAt: new Date(),
      });
      try {
        graph.updateTaskStatus(task.id, 'ready');
        taskRepo.updateStatus(task.id, 'ready');
        graph.updateTaskStatus(task.id, 'assigned');
        taskRepo.updateStatus(task.id, 'assigned');
        graph.updateTaskStatus(task.id, 'running');
        taskRepo.updateStatus(task.id, 'running');

        const executor = this.ctx.collaborativeExecutors.get(task.id)!;
        const res = await executor(task, this.ctx);
        if (!res.success) {
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

        graph.updateTaskStatus(task.id, 'completed');
        taskRepo.updateStatus(task.id, 'completed');

        // Verification
        graph.updateTaskStatus(task.id, 'verification');
        taskRepo.updateStatus(task.id, 'verification');
        this.ctx.activityTracker?.updateStatus(task.id, 'Running automated verification checks...');
        this.ctx.onProgress?.(`[${task.id}] Running verification checks...`);

        const verifyPath = (res as any).worktreePath ?? this.ctx.repoRoot;
        const verResult = await verificationRunner.verify({
          taskId: task.id,
          runId,
          worktreePath: verifyPath,
          config,
          taskType: task.type,
        });


        if (!verResult.passed) {
          const rework = taskRepo.incrementRework(task.id);
          this.ctx.onProgress?.(
            `[${task.id}] Collaborative verification failed: ${verResult.failureReason} (rework ${rework}/${config.verification.maxReworkCycles})`,
          );
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

        graph.updateTaskStatus(task.id, 'verified');
        taskRepo.updateStatus(task.id, 'verified');
        this.ctx.onProgress?.(`[${task.id}] Verified successfully ✓`);

        if (res.commitHash && res.commitHash !== baseCommit) {
          await integrationService.integrateTaskCommit({
            runId,
            taskId: task.id,
            commitHash: res.commitHash,
            baseCommit,
          });
          this.hasIntegratedCommits = true;
        }

        graph.updateTaskStatus(task.id, 'integrated');
        taskRepo.updateStatus(task.id, 'integrated');
        return;
      } finally {
        this.ctx.activityTracker?.complete(task.id);
      }
    }

    // 1. Transition task state: accepted -> ready -> assigned -> running
    graph.updateTaskStatus(task.id, 'ready');
    taskRepo.updateStatus(task.id, 'ready');

    graph.updateTaskStatus(task.id, 'assigned');
    taskRepo.updateStatus(task.id, 'assigned');

    const assignmentId = `asgn-${task.id}-${randomUUID().slice(0, 8)}`;
    const assignment: AgentAssignment = {
      id: assignmentId,
      taskId: task.id,
      agentId,
      role: 'implementer',
      objective: task.contract.objective || task.description,
      status: 'running',
    };

    assignmentRepo.create(assignment, runId);
    this.ctx.onProgress?.(`[${task.id}] Assigned to ${agent.name}: "${task.title}"`);

    try {
      // 2. Create isolated worktree for this assignment
      const isInvestigation = task.type === 'investigation';
      if (isInvestigation) {
        this.ctx.onProgress?.(`[${task.id}] Created isolated read-only workspace`);
      } else {
        this.ctx.onProgress?.(`[${task.id}] Created isolated worktree`);
      }

      graph.updateTaskStatus(task.id, 'running');
      taskRepo.updateStatus(task.id, 'running');
      const previousFailures = this.failedAgentsByTask.get(task.id);
      if (previousFailures && previousFailures.size > 0) {
        this.ctx.onProgress?.(
          `[${task.id}] ↻ Failover reassigned to alternative agent ${agent.name}`,
        );
      }
      this.ctx.onProgress?.(`[${task.id}] Agent ${agent.name} executing...`);

      eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: task.id,
        type: 'TASK_STARTED',
        payload: { taskId: task.id, assignmentId },
        timestamp: new Date(),
      });

      // 3. Execute with agent through the governed assignment pipeline
      const govResult = await executeGovernedAssignment({
        runId,
        baseCommit,
        repoRoot: this.ctx.repoRoot,
        config,
        task,
        assignment,
        agent,
        detached: isInvestigation,
        worktreeManager,
        workspaceRepo,
        assignmentRepo,
        executionRepo,
        eventRepo,
        interactionGateway: this.ctx.interactionGateway,
        activityTracker: this.ctx.activityTracker,
        abortSignal,
        onAttention: (kind) => {
          taskRepo.updateStatus(task.id, kind);
          graph.updateTaskStatus(task.id, kind);
        },
        onResumed: () => {
          taskRepo.updateStatus(task.id, 'running');
          graph.updateTaskStatus(task.id, 'running');
        },
      });

      const wt = { path: govResult.worktreePath };
      const agentResult = {
        success: govResult.success,
        commitHash: govResult.commitHash,
        output: govResult.output,
        message: govResult.message,
        durationMs: govResult.durationMs,
        collaborationProposal: govResult.collaborationProposal,
      };

    if (agentResult.collaborationProposal && this.ctx.escalationHandler) {
      this.ctx.escalationHandler.handleEscalation({
        runId,
        taskId: task.id,
        workerAgentId: agentId,
        proposal: agentResult.collaborationProposal,
      });
      graph.updateTaskStatus(task.id, 'blocked');
      taskRepo.updateStatus(task.id, 'blocked');
      this.ctx.onProgress?.(
        `[${task.id}] Emergent collaboration escalated (${agentResult.collaborationProposal.reason})`,
      );
      return;
    }

    if (!agentResult.success) {
      const rework = taskRepo.incrementRework(task.id);

      const errorSnippet = agentResult.output
        ? agentResult.output
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .find(
              (l) =>
                l.toLowerCase().includes('error') ||
                l.toLowerCase().includes('limit') ||
                l.toLowerCase().includes('failed'),
            ) || agentResult.message
        : agentResult.message;

      this.ctx.onProgress?.(
        `[${task.id}] Agent ${agent.name} failed (${agentResult.message}${errorSnippet && errorSnippet !== agentResult.message ? `: ${errorSnippet}` : ''})`,
      );

      if (!this.failedAgentsByTask.has(task.id)) {
        this.failedAgentsByTask.set(task.id, new Set());
      }
      this.failedAgentsByTask.get(task.id)!.add(agentId);

      if (rework <= config.verification.maxReworkCycles) {
        graph.updateTaskStatus(task.id, 'failed');
        taskRepo.updateStatus(task.id, 'failed');
        graph.updateTaskStatus(task.id, 'retrying');
        taskRepo.updateStatus(task.id, 'retrying');
        graph.updateTaskStatus(task.id, 'ready');
        taskRepo.updateStatus(task.id, 'ready');
      } else {
        graph.updateTaskStatus(task.id, 'failed');
        taskRepo.updateStatus(task.id, 'failed');
        graph.updateTaskStatus(task.id, 'blocked');
        taskRepo.updateStatus(task.id, 'blocked');
      }
      return;
    }

    graph.updateTaskStatus(task.id, 'completed');
    taskRepo.updateStatus(task.id, 'completed');

    if (agentResult.output && agentResult.output.trim().length > 0) {
      this.taskOutputs[task.id] = agentResult.output.trim();
    }

    this.ctx.onProgress?.(
      `[${task.id}] Agent ${agent.name} completed (status: ${agentResult.success ? 'success' : 'failed'} in ${(agentResult.durationMs / 1000).toFixed(1)}s)`,
    );

    if (
      task.type === 'investigation' &&
      agentResult.output &&
      agentResult.output.trim().length > 0
    ) {
      this.ctx.onProgress?.(
        `[${task.id}] Analysis report prepared (${agentResult.output.trim().length} chars) ✓`,
      );
    }

    eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId,
      taskId: task.id,
      type: 'TASK_COMPLETED',
      payload: { taskId: task.id, commitHash: agentResult.commitHash },
      timestamp: new Date(),
    });

      // 4. Verification
      graph.updateTaskStatus(task.id, 'verification');
      taskRepo.updateStatus(task.id, 'verification');
      this.ctx.activityTracker?.updateStatus(task.id, 'Running automated verification checks...');
      this.ctx.onProgress?.(`[${task.id}] Running verification checks...`);

      const verResult = await verificationRunner.verify({
        taskId: task.id,
        runId,
        worktreePath: wt.path,
        config,
        taskType: task.type,
      });

      if (!verResult.passed) {
        const rework = taskRepo.incrementRework(task.id);
        this.ctx.onProgress?.(
          `[${task.id}] Verification failed: ${verResult.failureReason} (rework ${rework}/${config.verification.maxReworkCycles})`,
        );
        if (rework <= config.verification.maxReworkCycles) {
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'retrying');
          taskRepo.updateStatus(task.id, 'retrying');
          graph.updateTaskStatus(task.id, 'ready');
          taskRepo.updateStatus(task.id, 'ready');
        } else {
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        }
        return;
      }

      graph.updateTaskStatus(task.id, 'verified');
      taskRepo.updateStatus(task.id, 'verified');
      this.ctx.onProgress?.(`[${task.id}] Verified successfully ✓`);

      // 5. Integration: cherry-pick task commit into run integration branch
      if (agentResult.commitHash && agentResult.commitHash !== baseCommit) {
        this.ctx.activityTracker?.updateStatus(task.id, 'Integrating commit into run branch...');
        this.ctx.onProgress?.(
          `[${task.id}] Integrating commit ${agentResult.commitHash.slice(0, 7)}...`,
        );
        await integrationService.integrateTaskCommit({
          runId,
          taskId: task.id,
          commitHash: agentResult.commitHash,
          baseCommit,
        });
        this.hasIntegratedCommits = true;
        this.ctx.onProgress?.(`[${task.id}] Integrated successfully ✓`);
      }

      // 6. Cleanup: remove assignment worktree and delete intermediate branch
      await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});

      graph.updateTaskStatus(task.id, 'integrated');
      taskRepo.updateStatus(task.id, 'integrated');
    } finally {
      this.ctx.activityTracker?.complete(task.id);
    }
  }
}
