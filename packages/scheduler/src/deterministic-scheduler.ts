import { randomUUID } from 'node:crypto';
import {
  AgentAssignment,
  AgentStreamBus,
  AgentUnavailableError,
  AgentUsage,
  TaskForgeConfig,
  VerificationResult,
} from '@taskforge/shared';
import { TaskGraph, Task, computeTaskPriority } from '@taskforge/core';
import { AgentRegistry, AgentActivityTracker, AgentQuotaTracker } from '@taskforge/agents';
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
import {
  RecoveryIncident,
  RecoveryFailureClass,
  classifyVerificationFailure,
  decideTaskRecovery,
  formatRecoveryContext,
  recoveryConsumesRework,
  verificationEvidence,
} from './task-recovery.js';
import { allowedWritersForTask, verificationCommandsForTask } from './task-policy.js';

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
function requiresAutomatedRepositoryVerification(task: Task): boolean {
  switch (task.contract.completionMode) {
    case 'mutation':
    case 'verification':
      return true;
    case 'report':
    case 'review':
      return false;
    case undefined:
      return task.type === 'implementation' || task.type === 'refactoring' || task.type === 'testing';
    default:
      return true;
  }
}

function isLightweightReadOnlyTask(task: Task): boolean {
  return Boolean(task.contract.metadata?.lightweightReadOnlyInvariant);
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
  private recoveryIncidentsByTask = new Map<string, RecoveryIncident[]>();
  private recoveryBaseCommitByTask = new Map<string, string>();

  constructor(private ctx: SchedulerContext) {
    this.concurrency = new ConcurrencyManager(ctx.config);
    this.ctx.concurrency = this.concurrency;
    this.completionGate = new CompletionGate(ctx.gitService);
  }

  private resolveAgentId(task: Task): string | undefined {
    const failed = this.failedAgentsByTask.get(task.id) ?? new Set<string>();
    const quotaTracker = AgentQuotaTracker.getInstance();
    const allowedWriters = allowedWritersForTask(task, this.ctx.config);
    const isAllowed = (agentId: string): boolean =>
      allowedWriters === undefined || allowedWriters.has(agentId);

    if (this.ctx.preferredAgentMapping && this.ctx.preferredAgentMapping[task.id]) {
      const preferred = this.ctx.preferredAgentMapping[task.id];
      if (!failed.has(preferred) && quotaTracker.isAvailable(preferred) && isAllowed(preferred)) {
        return preferred;
      }
    }
    const configuredAgent = this.ctx.config.planner.agent;
    if (
      configuredAgent &&
      this.ctx.agentRegistry.get(configuredAgent) &&
      !failed.has(configuredAgent) &&
      quotaTracker.isAvailable(configuredAgent) &&
      isAllowed(configuredAgent)
    ) {
      return configuredAgent;
    }
    const available = this.ctx.agentRegistry
      .list()
      .filter(
        (agent) =>
          !failed.has(agent.id) &&
          quotaTracker.isAvailable(agent.id) &&
          isAllowed(agent.id),
      );

    if (available.length === 0 && allowedWriters && allowedWriters.size > 0) {
      this.ctx.onProgress?.(
        `[${task.id}] ✗ No healthy agent is authorized to write scope ${task.contract.allowedScope.join(', ')}. Allowed writers: ${[...allowedWriters].join(', ')}.`,
      );
    }

    return available[0]?.id;
  }

  private objectiveWithDependencyEvidence(task: Task): string {
    const baseObjective = task.contract.objective || task.description;
    const dependencyEvidence = task.dependencies
      .map((dependencyId) => {
        const output = this.taskOutputs[dependencyId];
        if (!output || output.trim().length === 0) return undefined;
        const dependency = this.ctx.graph.getTask(dependencyId);
        const label = dependency?.title ?? dependencyId;
        return `[${dependencyId} — ${label}]\n${output.trim()}`;
      })
      .filter((entry): entry is string => Boolean(entry));
    const recoveryContext = formatRecoveryContext(
      this.recoveryIncidentsByTask.get(task.id) ?? [],
    );

    if (dependencyEvidence.length === 0 && !recoveryContext) return baseObjective;

    const parts = [baseObjective];
    if (dependencyEvidence.length > 0) {
      parts.push(
        '',
        'Authoritative evidence from completed prerequisite tasks:',
        ...dependencyEvidence,
        '',
        'Treat the prerequisite decisions above as implementation/review constraints. Do not silently choose a conflicting architecture or ownership boundary.',
      );
    }
    if (recoveryContext) {
      parts.push('', recoveryContext);
    }
    return parts.join('\n');
  }

  private async resolveTaskBaseCommit(task: Task): Promise<string> {
    const recoveryBase = this.recoveryBaseCommitByTask.get(task.id);
    if (recoveryBase) {
      this.ctx.onProgress?.(
        `[${task.id}] ↻ Continuing recovery from candidate commit ${recoveryBase.slice(0, 7)}`,
      );
      return recoveryBase;
    }

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

  private async recoverTask(
    task: Task,
    params: {
      agentId: string;
      phase: RecoveryIncident['phase'];
      failureClass?: RecoveryFailureClass;
      reason: string;
      evidence?: string;
      candidateCommit?: string;
      assignmentId?: string;
    },
  ): Promise<'retry_same_agent' | 'reassign' | 'block'> {
    const failureClass = params.failureClass ?? 'code_or_test';
    const rework = recoveryConsumesRework(failureClass)
      ? this.ctx.taskRepo.incrementRework(task.id)
      : task.reworkCount;
    const incident: RecoveryIncident = {
      attempt: rework,
      agentId: params.agentId,
      phase: params.phase,
      failureClass,
      reason: params.reason,
      evidence: params.evidence,
      candidateCommit: params.candidateCommit,
    };
    const history = this.recoveryIncidentsByTask.get(task.id) ?? [];
    history.push(incident);
    this.recoveryIncidentsByTask.set(task.id, history);

    if (params.candidateCommit && params.candidateCommit !== this.ctx.baseCommit) {
      this.recoveryBaseCommitByTask.set(task.id, params.candidateCommit);
    }

    const decision = decideTaskRecovery(
      rework,
      this.ctx.config.verification.maxReworkCycles,
      failureClass,
    );

    this.ctx.eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId: this.ctx.runId,
      taskId: task.id,
      type: decision.action === 'block' ? 'TASK_RECOVERY_BLOCKED' : 'TASK_RECOVERY_SCHEDULED',
      payload: {
        taskId: task.id,
        assignmentId: params.assignmentId,
        agentId: params.agentId,
        phase: params.phase,
        failureClass,
        reason: params.reason,
        evidence: params.evidence,
        candidateCommit: params.candidateCommit,
        attempt: rework,
        action: decision.action,
        retriesRemaining: decision.retriesRemaining,
      },
      timestamp: new Date(),
    });

    this.ctx.graph.updateTaskStatus(task.id, 'failed');
    this.ctx.taskRepo.updateStatus(task.id, 'failed');

    if (decision.action === 'block') {
      this.ctx.graph.updateTaskStatus(task.id, 'blocked');
      this.ctx.taskRepo.updateStatus(task.id, 'blocked');
      const blockReason =
        failureClass === 'verification_configuration'
          ? 'verification is not configured for this task scope'
          : failureClass === 'environment'
            ? 'the execution environment cannot satisfy the required verification'
            : failureClass === 'policy'
              ? 'a deterministic policy prevents safe continuation'
              : 'the recovery budget was exhausted';
      this.ctx.onProgress?.(
        `[${task.id}] ✗ Task is BLOCKED because ${blockReason}. Delivery remains disabled.`,
      );
      return 'block';
    }

    if (decision.action === 'reassign') {
      if (!this.failedAgentsByTask.has(task.id)) {
        this.failedAgentsByTask.set(task.id, new Set());
      }
      this.failedAgentsByTask.get(task.id)!.add(params.agentId);
      this.ctx.graph.updateTaskStatus(task.id, 'reassigned');
      this.ctx.taskRepo.updateStatus(task.id, 'reassigned');
      this.ctx.onProgress?.(
        failureClass === 'provider_quota'
          ? `[${task.id}] ↻ Provider unavailable/quota-limited: reassigning without consuming implementation rework budget.`
          : `[${task.id}] ↻ Recovery ${rework}/${this.ctx.config.verification.maxReworkCycles}: reassigning with failure evidence.`,
      );
    } else {
      this.ctx.graph.updateTaskStatus(task.id, 'retrying');
      this.ctx.taskRepo.updateStatus(task.id, 'retrying');
      this.ctx.onProgress?.(
        `[${task.id}] ↻ Recovery ${rework}/${this.ctx.config.verification.maxReworkCycles}: returning concrete failure evidence to the same agent.`,
      );
    }

    this.ctx.graph.updateTaskStatus(task.id, 'ready');
    this.ctx.taskRepo.updateStatus(task.id, 'ready');
    return decision.action;
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
        if (!agentId) {
          this.ctx.onProgress?.(
            `[${task.id}] ✗ No healthy coding agent is currently available; task will not be sent to a known-unavailable provider.`,
          );
          graph.updateTaskStatus(task.id, 'failed');
          this.ctx.taskRepo.updateStatus(task.id, 'failed');
          continue;
        }
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
    const executionObjective = this.objectiveWithDependencyEvidence(task);
    const executionTask =
      executionObjective === task.contract.objective
        ? task
        : {
            ...task,
            contract: {
              ...task.contract,
              objective: executionObjective,
            },
          };

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
        const res = await executor(executionTask, taskScopedContext);
        if (!res.success) {
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

        const verifyPath = (res as any).worktreePath ?? this.ctx.repoRoot;
        let collabCompletionVerification: VerificationResult | undefined;
        if (task.contract.completionMode === 'verification') {
          collabCompletionVerification = await verificationRunner.verify({
            taskId: task.id,
            runId,
            worktreePath: verifyPath,
            config,
            taskType: task.type,
            explicitCommands: task.contract.verification?.commands ?? [],
            expectation: task.contract.verification?.expectation ?? 'pass',
          });
        }

        const collabGate = await this.completionGate.evaluate({
          task,
          agentResult: {
            success: res.success,
            message: 'Collaborative execution completed',
            durationMs: 0,
            commitHash: res.commitHash,
            output: (res as any).output,
            findings: (res as any).findings,
          },
          baseCommit: taskBaseCommit,
          resultingCommit: res.commitHash,
          worktreePath: verifyPath,
          gitService: this.ctx.gitService,
          verificationPassed: collabCompletionVerification?.passed,
          verificationChecks: collabCompletionVerification?.checks,
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

        // Verification. Report/review contracts are validated by CompletionGate
        // and must not pay the cost of build/lint/test checks for a repository
        // they were explicitly forbidden to modify.
        graph.updateTaskStatus(task.id, 'verification');
        taskRepo.updateStatus(task.id, 'verification');
        const runAutomatedVerification = requiresAutomatedRepositoryVerification(task);
        if (runAutomatedVerification) {
          this.ctx.activityTracker?.updateStatus(
            collabAsgnId,
            'Running automated verification checks...',
          );
          this.ctx.onProgress?.(`[${task.id}] Running verification checks...`);
        } else {
          this.ctx.onProgress?.(
            `[${task.id}] Read-only report accepted; automated repository verification not applicable.`,
          );
        }

        const verResult =
          collabCompletionVerification ??
          (runAutomatedVerification
            ? await verificationRunner.verify({
                taskId: task.id,
                runId,
                worktreePath: verifyPath,
                config,
                taskType: task.type,
              })
            : ({ passed: true, checks: [] } as VerificationResult));


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
        if (runAutomatedVerification) {
          this.ctx.onProgress?.(`[${task.id}] Verified successfully ✓`);
        } else {
          this.ctx.onProgress?.(`[${task.id}] Report completion validated ✓`);
        }

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
      objective: executionObjective,
      status: 'running',
    };

    assignmentRepo.create(assignment, runId);
    this.ctx.onProgress?.(`[${task.id}] Assigned to ${agent.name}: "${task.title}"`);

    try {
      // 2. Create isolated worktree for this assignment
      const isReadOnlyTask =
        task.contract.completionMode === 'report' ||
        task.contract.completionMode === 'review' ||
        task.contract.forbiddenChanges?.includes('*');
      if (isReadOnlyTask) {
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
        detached: isReadOnlyTask,
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

      if (agentResult.collaborationProposal && isLightweightReadOnlyTask(task)) {
        this.ctx.onProgress?.(
          `[${task.id}] ℹ Collaboration request ignored: lightweight read-only overview is limited to one agent.`,
        );
        eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'COLLABORATION_REJECTED',
          payload: {
            taskId: task.id,
            reason: 'lightweight read-only overview invariant requires one agent',
            requestedRoles: agentResult.collaborationProposal.requestedRoles ?? [],
          },
          timestamp: new Date(),
        });
      } else if (agentResult.collaborationProposal && this.ctx.escalationHandler) {
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

        const quotaTracker = AgentQuotaTracker.getInstance();
        const availableAgents = this.ctx.agentRegistry
          .list()
          .filter((candidate) => quotaTracker.isAvailable(candidate.id))
          .map((candidate) => candidate.id);
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
      const reason =
        agentResult.message || errorSnippet || govResult.completionReason || 'Agent execution failed';

      this.ctx.onProgress?.(
        `[${task.id}] Agent ${agent.name} failed (${reason}${errorSnippet && errorSnippet !== reason ? `: ${errorSnippet}` : ''})`,
      );

      await this.recoverTask(task, {
        agentId,
        phase: 'execution',
        reason,
        evidence: agentResult.output,
        candidateCommit: agentResult.commitHash,
        assignmentId,
      });
      await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
      return;
    }

    let completionVerification: VerificationResult | undefined;
    if (task.contract.completionMode === 'verification') {
      completionVerification = await verificationRunner.verify({
        taskId: task.id,
        runId,
        worktreePath: wt.path,
        config,
        taskType: task.type,
        explicitCommands: task.contract.verification?.commands ?? [],
        expectation: task.contract.verification?.expectation ?? 'pass',
      });
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
      verificationPassed: completionVerification?.passed,
      verificationChecks: completionVerification?.checks,
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

      if (gateResult.failureReason === 'REQUIRED_ACTION_DENIED') {
        graph.updateTaskStatus(task.id, 'failed');
        taskRepo.updateStatus(task.id, 'failed');
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }

      if (task.type === 'review' && gateResult.failureReason === 'ACCEPTANCE_NOT_MET') {
        graph.updateTaskStatus(task.id, 'failed');
        taskRepo.updateStatus(task.id, 'failed');
        graph.updateTaskStatus(task.id, 'blocked');
        taskRepo.updateStatus(task.id, 'blocked');
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }

      await this.recoverTask(task, {
        agentId,
        phase: 'completion',
        reason: gateResult.failureReason ?? 'Completion gate rejected the attempt',
        evidence: gateResult.evidence.explanation,
        candidateCommit: agentResult.commitHash,
        assignmentId,
      });
      await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
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

      // 4. Verification. CompletionGate is the authoritative evidence check
      // for report/review tasks; build/lint/test are only meaningful when the
      // task can mutate code or explicitly requests deterministic verification.
      graph.updateTaskStatus(task.id, 'verification');
      taskRepo.updateStatus(task.id, 'verification');
      const runAutomatedVerification = requiresAutomatedRepositoryVerification(task);
      if (runAutomatedVerification) {
        this.ctx.activityTracker?.updateStatus(
          assignmentId,
          'Running automated verification checks...',
        );
        this.ctx.onProgress?.(`[${task.id}] Running verification checks...`);
      } else {
        this.ctx.onProgress?.(
          `[${task.id}] Read-only report accepted; automated repository verification not applicable.`,
        );
      }

      const verResult =
        completionVerification ??
        (runAutomatedVerification
          ? await verificationRunner.verify({
              taskId: task.id,
              runId,
              worktreePath: wt.path,
              config,
              taskType: task.type,
            })
          : ({ passed: true, checks: [] } as VerificationResult));

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
        this.ctx.onProgress?.(
          `[${task.id}] Verification failed: ${verResult.failureReason}`,
        );
        await this.recoverTask(task, {
          agentId,
          phase: 'verification',
          reason: verResult.failureReason ?? 'Automated verification failed',
          evidence: verificationEvidence(verResult.checks),
          candidateCommit: agentResult.commitHash,
          assignmentId,
        });
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }

      graph.updateTaskStatus(task.id, 'verified');
      taskRepo.updateStatus(task.id, 'verified');
      if (runAutomatedVerification) {
        this.ctx.onProgress?.(`[${task.id}] Verified successfully ✓`);
      } else {
        this.ctx.onProgress?.(`[${task.id}] Report completion validated ✓`);
      }

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
      this.recoveryIncidentsByTask.delete(task.id);
      this.recoveryBaseCommitByTask.delete(task.id);
    } finally {
      this.ctx.activityTracker?.completeAssignment(assignmentId);
    }
  }
}
