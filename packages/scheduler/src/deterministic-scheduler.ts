import { randomUUID } from 'node:crypto';
import {
  AgentAssignment,
  AgentStreamBus,
  AgentUnavailableError,
  AgentUsage,
  TaskForgeConfig,
} from '@taskforge/shared';
import { TaskGraph, Task, computeTaskPriority } from '@taskforge/core';
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
import { CommunicationBus, EscalationHandler, SessionRegistry } from '@taskforge/collaboration';
import { InteractionGateway } from '@taskforge/execution';
import { ConcurrencyManager } from './concurrency-manager.js';
import { executeGovernedAssignment } from './governed-assignment.js';
import { CompletionGate, sanitizeTaskOutput } from './completion-gate.js';

export interface SchedulerContext {
  runId: string;
  baseCommit: string;
  repoRoot: string;
  /** Verbatim request that started the run. */
  originalUserRequest?: string;
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
  streamBus?: AgentStreamBus;
  preferredAgentMapping?: Record<string, string>;
  abortSignal?: AbortSignal;
  negotiator?: NegotiationManager;
  concurrency?: ConcurrencyManager;
  communicationBus?: CommunicationBus;
  sessionRegistry?: SessionRegistry;
  escalationHandler?: EscalationHandler;
  onProgress?: (message: string) => void;
  onAgentUsage?: (observation: {
    task: Task;
    assignment: AgentAssignment;
    agentId: string;
    usage: AgentUsage;
  }) => void;
  collaborativeExecutors?: Map<
    string,
    (task: Task, ctx: SchedulerContext) => Promise<{ success: boolean; commitHash?: string }>
  >;
}

function roleForTaskType(taskType: Task['type']): AgentAssignment['role'] {
  switch (taskType) {
    case 'investigation':
      return 'researcher';
    case 'review':
      return 'reviewer';
    case 'testing':
      return 'tester';
    case 'architecture':
      return 'architecture_reviewer';
    case 'implementation':
    case 'refactoring':
    default:
      return 'implementer';
  }
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
  private completionGate: CompletionGate;
  private taskOutputs: Record<string, string> = {};
  private hasIntegratedCommits = false;
  private failedAgentsByTask = new Map<string, Set<string>>();

  constructor(private ctx: SchedulerContext) {
    this.concurrency = new ConcurrencyManager(ctx.config);
    this.ctx.concurrency = this.concurrency;
    this.completionGate = new CompletionGate(ctx.gitService);
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

  private async resolveTaskBaseCommit(task: Task): Promise<string> {
    if (task.dependencies.length === 0) {
      return this.ctx.baseCommit;
    }

    const integrationBranch = this.ctx.integrationService.getBranchName(this.ctx.runId);
    const exists = await this.ctx.gitService.branchExists(integrationBranch);
    if (!exists) {
      return this.ctx.baseCommit;
    }

    const cumulativeHead = await this.ctx.gitService.resolveRef(integrationBranch);
    if (cumulativeHead !== this.ctx.baseCommit) {
      this.ctx.onProgress?.(
        `[${task.id}] Using cumulative dependency state ${cumulativeHead.slice(0, 7)} as execution base`,
      );
    }
    return cumulativeHead;
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

      // Prioritize candidate tasks: higher-criticality or dependency-blocking tasks acquire slots first
      candidates.sort((a, b) => {
        const prioA = computeTaskPriority(a, graph);
        const prioB = computeTaskPriority(b, graph);
        return prioB - prioA;
      });

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

    // A dependent task must execute against the cumulative run state that
    // already contains its fully integrated dependencies. Root tasks keep the
    // original run base so unrelated work can still proceed independently.
    const taskBaseCommit = await this.resolveTaskBaseCommit(task);

    // Check for collaborative execution override
    if (this.ctx.collaborativeExecutors?.has(task.id)) {
      const collabAsgnId = `asgn-${task.id}-collab-${randomUUID().slice(0, 8)}`;
      this.ctx.activityTracker?.register({
        taskId: task.id,
        assignmentId: collabAsgnId,
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
        const taskScopedContext =
          taskBaseCommit === baseCommit ? this.ctx : { ...this.ctx, baseCommit: taskBaseCommit };
        const res = await executor(task, taskScopedContext);
        if (!res.success) {
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

        const verifyPath = (res as any).worktreePath ?? this.ctx.repoRoot;
        const collabGate = await this.completionGate.evaluate({
          task,
          agentResult: {
            success: res.success,
            message: 'Collaborative execution completed',
            durationMs: 0,
            commitHash: res.commitHash,
            output: (res as any).output,
          },
          baseCommit: taskBaseCommit,
          resultingCommit: res.commitHash,
          worktreePath: verifyPath,
          gitService: this.ctx.gitService,
        });

        if (!collabGate.accepted) {
          eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'COMPLETION_GATE_REJECTED',
            payload: {
              taskId: task.id,
              assignmentId: collabAsgnId,
              runId,
              accepted: false,
              failureReason: collabGate.failureReason,
              evidence: collabGate.evidence,
            },
            timestamp: new Date(),
          });
          this.ctx.onProgress?.(
            `[${task.id}] ✗ Completion gate rejected collaborative execution: ${collabGate.evidence.explanation || collabGate.failureReason}`,
          );
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

        eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'COMPLETION_GATE_ACCEPTED',
          payload: {
            taskId: task.id,
            assignmentId: collabAsgnId,
            runId,
            accepted: true,
            evidence: collabGate.evidence,
          },
          timestamp: new Date(),
        });

        graph.updateTaskStatus(task.id, 'completed');
        taskRepo.updateStatus(task.id, 'completed');

        const collabOutput = (res as any).output as string | undefined;
        if (collabOutput && collabOutput.trim().length > 0) {
          this.taskOutputs[task.id] = sanitizeTaskOutput(collabOutput);
        }

        // Verification
        graph.updateTaskStatus(task.id, 'verification');
        taskRepo.updateStatus(task.id, 'verification');
        this.ctx.activityTracker?.updateStatus(collabAsgnId, 'Running automated verification checks...');
        this.ctx.onProgress?.(`[${task.id}] Running verification checks...`);

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

        if (res.commitHash && res.commitHash !== taskBaseCommit) {
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
        this.ctx.activityTracker?.completeAssignment(collabAsgnId);
        const taskAssignments = this.ctx.assignmentRepo.listByTask(task.id);
        for (const asgn of taskAssignments) {
          await this.ctx.worktreeManager
            .removeWorktree(task.id, asgn.id, true, true)
            .catch(() => {});
        }
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
      role: roleForTaskType(task.type),
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
        baseCommit: taskBaseCommit,
        repoRoot: this.ctx.repoRoot,
        originalUserRequest: this.ctx.originalUserRequest,
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
        streamBus: this.ctx.streamBus,
        concurrency: this.concurrency,
        graph,
        priority: computeTaskPriority(task, graph),
        communicationBus: this.ctx.communicationBus,
        sessionRegistry: this.ctx.sessionRegistry,
        abortSignal,
        onUsage: (usage) => {
          this.ctx.onAgentUsage?.({ task, assignment, agentId: agent.id, usage });
        },
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

        const maxAgents = this.ctx.config.collaboration?.maxAgentsPerTask ?? 3;
        const existingAssignments = assignmentRepo.listByTask(task.id);
        const requestedRoles = agentResult.collaborationProposal.requestedRoles?.length
          ? agentResult.collaborationProposal.requestedRoles
          : ['reviewer' as const];

        if (existingAssignments.length >= maxAgents) {
          this.ctx.onProgress?.(
            `[${task.id}] ⚠ Emergent collaboration rejected: maxAgentsPerTask limit (${maxAgents}) reached.`,
          );
          eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'COLLABORATION_REJECTED',
            payload: {
              taskId: task.id,
              reason: `maxAgentsPerTask limit (${maxAgents}) reached`,
              existingCount: existingAssignments.length,
            },
            timestamp: new Date(),
          });
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          return;
        }

        const availableAgents = this.ctx.agentRegistry.list().map((a) => a.id);
        const candidateAgentId =
          availableAgents.find((id) => id !== agentId) ?? availableAgents[0];
        const candidateAgent = candidateAgentId ? this.ctx.agentRegistry.get(candidateAgentId) : undefined;

        if (!candidateAgent) {
          this.ctx.onProgress?.(
            `[${task.id}] ⚠ Emergent collaboration rejected: no suitable alternative agent found.`,
          );
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          return;
        }

        if (this.concurrency && !this.concurrency.canSchedule(candidateAgent.id)) {
          this.ctx.onProgress?.(
            `[${task.id}] ⚠ Emergent collaboration delayed: concurrency slot unavailable for ${candidateAgent.name}.`,
          );
          eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'COLLABORATION_DELAYED',
            payload: {
              taskId: task.id,
              reason: 'concurrency unavailable',
              agentId: candidateAgent.id,
            },
            timestamp: new Date(),
          });
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

        task.contract.metadata = {
          ...task.contract.metadata,
          emergentCollaboration: {
            reason: agentResult.collaborationProposal.reason,
            requestedBy: agentId,
            providedAgent: candidateAgent.id,
            role: requestedRoles[0],
          },
        };

        this.ctx.onProgress?.(
          `[${task.id}] ✦ Emergent collaboration approved: adding ${candidateAgent.name} (${requestedRoles[0]}) to help with "${agentResult.collaborationProposal.reason}".`,
        );

        eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'COLLABORATION_APPROVED',
          payload: {
            taskId: task.id,
            reason: agentResult.collaborationProposal.reason,
            addedAgent: candidateAgent.id,
            role: requestedRoles[0],
          },
          timestamp: new Date(),
        });

        const newAsgnId = `asgn-${task.id}-${randomUUID().slice(0, 8)}`;
        const newAsgn: AgentAssignment = {
          id: newAsgnId,
          taskId: task.id,
          agentId: candidateAgent.id,
          role: requestedRoles[0],
          objective: `${agentResult.collaborationProposal.reason}: ${task.contract.objective}`,
          status: 'running',
        };
        assignmentRepo.create(newAsgn, runId);

        const isReviewer = requestedRoles[0] === 'reviewer';
        const baseCommitForNew = agentResult.commitHash ?? taskBaseCommit;

        const newGovResult = await executeGovernedAssignment({
          runId,
          baseCommit: baseCommitForNew,
          repoRoot: this.ctx.repoRoot,
          originalUserRequest: this.ctx.originalUserRequest,
          config,
          task,
          assignment: newAsgn,
          agent: candidateAgent,
          detached: isReviewer,
          existingWorktree: isReviewer ? undefined : wt,
          worktreeManager,
          workspaceRepo,
          assignmentRepo,
          executionRepo,
          eventRepo,
          interactionGateway: this.ctx.interactionGateway,
          activityTracker: this.ctx.activityTracker,
          streamBus: this.ctx.streamBus,
          concurrency: this.concurrency,
          communicationBus: this.ctx.communicationBus,
          sessionRegistry: this.ctx.sessionRegistry,
          abortSignal,
          onUsage: (usage) => {
            this.ctx.onAgentUsage?.({
              task,
              assignment: newAsgn,
              agentId: candidateAgent.id,
              usage,
            });
          },
          onAttention: (kind) => {
            taskRepo.updateStatus(task.id, kind);
            graph.updateTaskStatus(task.id, kind);
          },
          onResumed: () => {
            taskRepo.updateStatus(task.id, 'running');
            graph.updateTaskStatus(task.id, 'running');
          },
        });

        if (isReviewer) {
          await worktreeManager.removeWorktree(task.id, newAsgn.id, true, true).catch(() => {});
        }

        if (!newGovResult.success) {
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          this.ctx.onProgress?.(`[${task.id}] ✗ Emergent collaborator ${candidateAgent.name} failed.`);
          return;
        }

        agentResult.success = true;
        if (newGovResult.commitHash) {
          agentResult.commitHash = newGovResult.commitHash;
        }
        this.ctx.onProgress?.(`[${task.id}] ✓ Emergent collaboration completed with ${candidateAgent.name}.`);
      }

    const isActionDenied =
      govResult.completionReason === 'REQUIRED_ACTION_DENIED' ||
      Boolean(govResult.normalizedOutcome?.deniedActions?.length);

    if (!agentResult.success && !isActionDenied) {
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

    const gateResult = await this.completionGate.evaluate({
      task,
      assignment,
      agentResult: {
        success: agentResult.success,
        commitHash: agentResult.commitHash,
        output: agentResult.output,
        message: agentResult.message ?? '',
        durationMs: agentResult.durationMs,
        collaborationProposal: agentResult.collaborationProposal,
        findings: govResult.findings,
        normalizedOutcome: govResult.normalizedOutcome,
        completionReason: govResult.completionReason,
      },
      normalizedOutcome: govResult.normalizedOutcome,
      baseCommit: taskBaseCommit,
      resultingCommit: agentResult.commitHash,
      worktreePath: wt.path,
      gitService: this.ctx.gitService,
    });

    if (!gateResult.accepted) {
      eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: task.id,
        type: 'COMPLETION_GATE_REJECTED',
        payload: {
          taskId: task.id,
          assignmentId,
          runId,
          accepted: false,
          failureReason: gateResult.failureReason,
          evidence: gateResult.evidence,
        },
        timestamp: new Date(),
      });

      if (gateResult.failureReason) {
        assignmentRepo.updateStatus(
          assignmentId,
          'failed',
          undefined,
          undefined,
          gateResult.failureReason,
        );
      }

      const failMsg =
        gateResult.evidence.explanation || gateResult.failureReason || 'Completion gate rejected';
      this.ctx.onProgress?.(`[${task.id}] ✗ Completion gate rejected: ${failMsg}`);

      if (!this.failedAgentsByTask.has(task.id)) {
        this.failedAgentsByTask.set(task.id, new Set());
      }
      this.failedAgentsByTask.get(task.id)!.add(agentId);

      if (gateResult.failureReason === 'REQUIRED_ACTION_DENIED') {
        graph.updateTaskStatus(task.id, 'failed');
        taskRepo.updateStatus(task.id, 'failed');
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }

      const rework = taskRepo.incrementRework(task.id);
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

    eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId,
      taskId: task.id,
      type: 'COMPLETION_GATE_ACCEPTED',
      payload: {
        taskId: task.id,
        assignmentId,
        runId,
        accepted: true,
        evidence: gateResult.evidence,
      },
      timestamp: new Date(),
    });

    graph.updateTaskStatus(task.id, 'completed');
    taskRepo.updateStatus(task.id, 'completed');

    if (agentResult.output && agentResult.output.trim().length > 0) {
      this.taskOutputs[task.id] = sanitizeTaskOutput(agentResult.output);
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
      this.ctx.activityTracker?.updateStatus(assignmentId, 'Running automated verification checks...');
      this.ctx.onProgress?.(`[${task.id}] Running verification checks...`);

      const verResult = await verificationRunner.verify({
        taskId: task.id,
        runId,
        worktreePath: wt.path,
        config,
        taskType: task.type,
      });

      if (!verResult.passed) {
        eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'COMPLETION_GATE_REJECTED',
          payload: {
            taskId: task.id,
            assignmentId,
            runId,
            accepted: false,
            failureReason: 'VERIFICATION_FAILED',
            evidence: {
              verificationPassed: false,
              explanation: `Automated verification failed: ${verResult.failureReason}`,
            },
          },
          timestamp: new Date(),
        });
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
      if (agentResult.commitHash && agentResult.commitHash !== taskBaseCommit) {
        this.ctx.activityTracker?.updateStatus(assignmentId, 'Integrating commit into run branch...');
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
      this.ctx.activityTracker?.completeAssignment(assignmentId);
    }
  }
}
