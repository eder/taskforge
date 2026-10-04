import { randomUUID } from 'node:crypto';
import { missingFileIsAgentsMistake, refusedPort } from './environment-repair.js';
import {
  AgentAssignment,
  AgentStreamBus,
  AgentUnavailableError,
  AgentUsage,
  TaskForgeConfig,
  VerificationResult,
  CheckBaseline,
  IntegrationError,
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
import { VerificationRunner, isDocumentationOnlyChange, testsActuallyRan } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { NegotiationManager } from '@taskforge/negotiation';
import { CommunicationBus, EscalationHandler, SessionRegistry } from '@taskforge/collaboration';
import { InteractionGateway } from '@taskforge/execution';
import { ConcurrencyManager } from './concurrency-manager.js';
import { executeGovernedAssignment, GovernedAssignmentResult } from './governed-assignment.js';
import { CompletionGate, sanitizeTaskOutput } from './completion-gate.js';
import {
  PreservedCandidate,
  candidateNeedsNoAgent,
  describeCompletionFailure,
  RecoveryIncident,
  RecoveryFailureClass,
  classifyCompletionFailure,
  classifyExecutionFailure,
  classifyVerificationFailure,
  decideTaskRecovery,
  formatRecoveryContext,
  recoveryConsumesRework,
  verificationEvidence,
} from './task-recovery.js';
import {
  allowedWritersForTask,
  filesOutsideScope,
  verificationCommandsForTask,
} from './task-policy.js';
import {
  assessTaskSensitivity,
  buildDualReviewObjective,
  parseReviewVerdict,
  selectIndependentReviewer,
  taskProducesChanges,
} from './dual-review.js';

/** State carried over from a previous, interrupted execution of the same run. */
export interface SchedulerResumeState {
  /** Sanitized outputs of tasks completed before the interruption. */
  taskOutputs: Record<string, string>;
  /** Whether the run branch already holds integrated task commits. */
  hasIntegratedCommits: boolean;
  /** Ids of tasks whose commits were integrated into the run branch. */
  commitTaskIds?: string[];
  /** Work kept from tasks that were blocked, keyed by task id (see PreservedCandidate). */
  candidates?: Record<string, PreservedCandidate>;
}

export interface SchedulerContext {
  runId: string;
  /** Stop starting tasks once this many tokens were spent (see execution.tokenBudget). */
  tokenBudget?: number;
  /** Provider-reported tokens spent in this run so far; paired with tokenBudget. */
  tokensSpent?: () => number;
  baseCommit: string;
  repoRoot: string;
  /** Verbatim request that started the run. */
  originalUserRequest?: string;
  /** Reference output of an earlier run the request refers to (see run-context.ts). */
  priorContext?: string;
  /** What the user asked for when continuing this run (see AgentContext.userGuidance). */
  userGuidance?: string;
  config: TaskForgeConfig;
  graph: TaskGraph;
  agentRegistry: AgentRegistry;
  worktreeManager: WorktreeManager;
  gitService: GitService;
  verificationRunner: VerificationRunner;
  integrationService: IntegrationService;
  runRepo: RunRepository;
  /** Present when continuing an interrupted run via `RunOrchestrator.resume()`. */
  resumeState?: SchedulerResumeState;
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
  /** Tasks whose commits are on the run branch; read-only report tasks never appear here. */
  private commitTaskIds = new Set<string>();
  /** Blocked work kept on a branch; see preserveCandidate / reuseCandidate. */
  private candidates = new Map<string, PreservedCandidate>();
  private pendingPreserves: Promise<void>[] = [];
  private failedAgentsByTask = new Map<string, Set<string>>();
  private recoveryIncidentsByTask = new Map<string, RecoveryIncident[]>();
  private recoveryBaseCommitByTask = new Map<string, string>();

  constructor(private ctx: SchedulerContext) {
    this.concurrency = new ConcurrencyManager(ctx.config);
    this.ctx.concurrency = this.concurrency;
    this.completionGate = new CompletionGate(ctx.gitService);
    if (ctx.resumeState) {
      this.taskOutputs = { ...ctx.resumeState.taskOutputs };
      this.hasIntegratedCommits = ctx.resumeState.hasIntegratedCommits;
      this.commitTaskIds = new Set(ctx.resumeState.commitTaskIds ?? []);
      for (const [taskId, candidate] of Object.entries(ctx.resumeState.candidates ?? {})) {
        this.candidates.set(taskId, candidate);
        // Blockers about the work itself: the agent continues from the kept
        // commit with what went wrong, instead of starting over.
        if (!candidateNeedsNoAgent(candidate)) {
          this.recoveryBaseCommitByTask.set(taskId, candidate.commit);
          this.recoveryIncidentsByTask.set(taskId, [
            {
              attempt: 1,
              agentId: candidate.agentId ?? 'unknown',
              phase: candidate.phase as RecoveryIncident['phase'],
              failureClass: candidate.failureClass,
              reason: candidate.reason,
              evidence: candidate.evidence,
              candidateCommit: candidate.commit,
            },
          ]);
        }
      }
    }
  }

  /**
   * Keeps work that did not make it to the run branch on a named branch, so a
   * blocked task never strands what the agents produced, and records it in the
   * run metadata so `tf resume` can reuse it.
   */
  private preserveCandidate(
    task: Task,
    candidate: Omit<PreservedCandidate, 'branch' | 'commit'> & { commit?: string },
  ): void {
    const commit = candidate.commit;
    if (!commit || commit === this.ctx.baseCommit) return;
    const branch = `taskforge/candidate/${this.ctx.runId.replace(/^run-/, '')}/${task.id}`;
    const kept: PreservedCandidate = { ...candidate, commit, branch, reason: candidate.reason.slice(0, 600), evidence: candidate.evidence?.slice(0, 1500) };
    this.candidates.set(task.id, kept);
    const work = this.ctx.gitService
      .execGit(['branch', '-f', branch, commit])
      .then(() => {
        this.ctx.runRepo.mergeMetadata(this.ctx.runId, {
          candidates: Object.fromEntries(this.candidates),
        });
        this.ctx.eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId: this.ctx.runId,
          taskId: task.id,
          type: 'TASK_CANDIDATE_PRESERVED',
          payload: { taskId: task.id, branch, commit, phase: kept.phase, failureClass: kept.failureClass },
          timestamp: new Date(),
        });
        this.ctx.onProgress?.(
          `[${task.id}] Work kept on branch ${branch} (${commit.slice(0, 7)}). After fixing the cause, "tf resume ${this.ctx.runId}" re-checks it${candidateNeedsNoAgent(kept) ? ' without calling any agent' : ' and lets the agent continue from it'}.`,
        );
      })
      .catch(() => {
        // never let bookkeeping break the run
      });
    this.pendingPreserves.push(work);
  }

  private clearCandidate(taskId: string): void {
    if (!this.candidates.delete(taskId)) return;
    this.ctx.runRepo.mergeMetadata(this.ctx.runId, { candidates: Object.fromEntries(this.candidates) });
  }

  /** A kept candidate whose blocker was not about the work: only the checks need to run again. */
  private reusableCandidate(task: Task): PreservedCandidate | undefined {
    const candidate = this.candidates.get(task.id);
    return candidate && candidateNeedsNoAgent(candidate) ? candidate : undefined;
  }

  /** Stands in for an agent run: puts the kept commit in a worktree so gates and checks run on it. */
  private async reuseCandidate(
    task: Task,
    candidate: PreservedCandidate,
    assignmentId: string,
  ): Promise<GovernedAssignmentResult> {
    this.ctx.onProgress?.(
      `[${task.id}] ↻ Reusing the work kept from the previous attempt (${candidate.commit.slice(0, 7)}): re-running the checks only, no agent call.`,
    );
    const wt = await this.ctx.worktreeManager.createWorktree(task.id, assignmentId, candidate.commit, {
      detached: true,
    });
    return {
      success: true,
      commitHash: candidate.commit,
      output: 'Work kept from a previous attempt; re-verified without calling an agent.',
      worktreePath: wt.path,
      durationMs: 0,
    };
  }

  /**
   * Durable record of why a task ended failed/blocked. Progress lines scroll
   * away and some failure paths printed nothing at all, which left users with
   * "Tasks failed: 1" and no explanation. `tf inspect` and the run summary read
   * this event.
   */
  private noteTaskFailure(task: Task, phase: string, reason: string): void {
    const text = reason.replace(/\s+/g, ' ').trim().slice(0, 500) || 'no reason was recorded';
    this.ctx.eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId: this.ctx.runId,
      taskId: task.id,
      type: 'TASK_FAILED',
      payload: { taskId: task.id, phase, reason: text },
      timestamp: new Date(),
    });
  }

  /** Marks that a task's commit is now on the run branch. `tf resume` needs this
   * to tell tasks whose work lives in git (must be redone if the branch is
   * gone) from read-only report tasks (nothing to lose, never redo them).
   */
  private recordIntegratedCommit(taskId: string): void {
    this.hasIntegratedCommits = true;
    this.commitTaskIds.add(taskId);
    this.ctx.runRepo.mergeMetadata(this.ctx.runId, { commitTaskIds: [...this.commitTaskIds] });
  }

  /** Keeps the output in memory and checkpoints it so a resumed run can still feed dependents. */
  private recordTaskOutput(taskId: string, output: string): void {
    this.taskOutputs[taskId] = sanitizeTaskOutput(output);
    this.ctx.runRepo.mergeMetadata(this.ctx.runId, { taskOutputs: this.taskOutputs });
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

    return this.resolveCumulativeBase(task);
  }

  /** The run state a task started from, ignoring any recovery candidate. */
  private async resolveCumulativeBase(task: Task): Promise<string> {
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

  /** classifyVerificationFailure, plus: a missing file that exists nowhere in the checkout is the change's mistake. */
  private classifyVerification(reason?: string, evidence?: string): RecoveryFailureClass {
    const base = classifyVerificationFailure(reason, evidence);
    if (base === 'environment' && missingFileIsAgentsMistake(this.ctx.repoRoot, `${reason ?? ''}\n${evidence ?? ''}`)) {
      return 'code_or_test';
    }
    return base;
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
      this.preserveCandidate(task, {
        commit: params.candidateCommit,
        phase: params.phase,
        failureClass,
        reason: params.reason,
        evidence: params.evidence,
        agentId: params.agentId,
      });
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
          ? 'verification is not configured for this task scope (add verification.commands to .taskforge/config.yaml; run "tf init" to generate it)'
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

  /**
   * A recovery retry builds on the previous candidate commit, so its commit
   * only holds the delta against that candidate. Cherry-picking it alone onto
   * the run branch would conflict (or drop the earlier work). Represent the
   * attempt chain as one commit holding the task's full delta against the
   * state the task originally started from. Returns undefined when that
   * cumulative delta is empty (nothing to integrate).
   */
  private async commitForIntegration(
    task: Task,
    commitHash: string,
    worktreePath: string,
  ): Promise<string | undefined> {
    if (!this.recoveryBaseCommitByTask.has(task.id)) return commitHash;
    const git = this.ctx.gitService;
    const base = await this.resolveCumulativeBase(task);
    const tree = await git.getTreeHash(commitHash, worktreePath);
    if (tree === (await git.getTreeHash(base, worktreePath))) return undefined;
    return git.commitTree(tree, base, `${task.title} (${task.id})`, worktreePath);
  }

  /** Files the task changed, relative to the state it started from (recovery candidates ignored). */
  private async changedFilesSinceTaskStart(
    task: Task,
    commitHash: string | undefined,
    worktreePath: string,
  ): Promise<string[]> {
    if (!commitHash) return [];
    const base = await this.resolveCumulativeBase(task);
    const out = await new GitService(worktreePath)
      .exec(['diff', '--name-only', base, commitHash], worktreePath)
      .catch(() => '');
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Documentation-only changes need no code verification. Only applies when
   * no explicit verification commands are configured for the task; those
   * still run, and still must pass, whatever the change contains.
   */
  private async isDocumentationOnly(
    task: Task,
    commitHash: string | undefined,
    worktreePath: string,
  ): Promise<boolean> {
    if (!commitHash || !taskProducesChanges(task)) return false;
    if ((verificationCommandsForTask(task, this.ctx.config) ?? []).length > 0) return false;
    return isDocumentationOnlyChange(
      await this.changedFilesSinceTaskStart(task, commitHash, worktreePath),
    );
  }

  /**
   * Deterministic write-boundary check: every file the task changed (relative
   * to the state it started from, ignoring recovery candidates) must fall
   * inside its declared allowedScope. Returns the offending files.
   */
  private async findScopeViolations(
    task: Task,
    commitHash: string | undefined,
    worktreePath: string,
  ): Promise<string[]> {
    if (this.ctx.config.verification.enforceScope === false) return [];
    const scopes = task.contract.allowedScope;
    if (!commitHash || !taskProducesChanges(task) || !scopes || scopes.length === 0) return [];
    const violations = filesOutsideScope(
      scopes,
      await this.changedFilesSinceTaskStart(task, commitHash, worktreePath),
    );
    if (violations.length > 0) {
      this.ctx.eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId: this.ctx.runId,
        taskId: task.id,
        type: 'SCOPE_VIOLATION',
        payload: { taskId: task.id, allowedScope: scopes, violations, commitHash },
        timestamp: new Date(),
      });
    }
    return violations;
  }

  /**
   * Mandatory independent review for sensitive tasks (opt-in via
   * `verification.dualReview`). Runs after automated verification and before
   * the change is marked verified/integrated. The reviewer is always a
   * different agent than any that worked on the task, runs read-only in a
   * detached worktree at the candidate commit, and must emit an explicit
   * verdict line; anything else fails closed.
   */
  private async runDualReviewGate(
    task: Task,
    params: { implementerAgentIds: string[]; candidateCommit?: string; taskBaseCommit: string },
  ): Promise<
    | { decision: 'not_required' | 'approved' }
    | { decision: 'rejected'; reviewerId: string; findings: string }
    | { decision: 'unavailable'; reason: string; block: boolean }
  > {
    const { config, runId, eventRepo, assignmentRepo, worktreeManager } = this.ctx;
    const assessment = assessTaskSensitivity(task, config);
    const { candidateCommit, taskBaseCommit } = params;
    if (
      !assessment.sensitive ||
      !taskProducesChanges(task) ||
      !candidateCommit ||
      candidateCommit === taskBaseCommit
    ) {
      return { decision: 'not_required' };
    }

    const block = config.verification.dualReview.onNoIndependentReviewer === 'block';
    eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId,
      taskId: task.id,
      type: 'DUAL_REVIEW_REQUIRED',
      payload: { taskId: task.id, reasons: assessment.reasons, candidateCommit },
      timestamp: new Date(),
    });
    this.ctx.onProgress?.(
      `[${task.id}] Sensitive task (${assessment.reasons[0]}); independent review required`,
    );

    // Anyone who worked on this task (any role) is not independent.
    const excluded = new Set(params.implementerAgentIds);
    for (const record of assignmentRepo.listByTask(task.id)) {
      if (!record.id.includes('-review-')) excluded.add(record.agentId);
    }

    const reviewObjective = buildDualReviewObjective({
      task,
      implementerAgentIds: [...excluded],
      candidateCommit,
      baseCommit: taskBaseCommit,
      reasons: assessment.reasons,
    });
    const reviewer = await selectIndependentReviewer(
      this.ctx.agentRegistry.list(),
      excluded,
      reviewObjective,
    );
    if (!reviewer) {
      const reason = `no healthy agent other than [${[...excluded].join(', ')}] is available to review`;
      eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: task.id,
        type: 'DUAL_REVIEW_UNAVAILABLE',
        payload: { taskId: task.id, reason, policy: block ? 'block' : 'skip' },
        timestamp: new Date(),
      });
      return { decision: 'unavailable', reason, block };
    }

    const reviewAssignment: AgentAssignment = {
      id: `asgn-${task.id}-review-${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      agentId: reviewer.id,
      role: 'reviewer',
      objective: reviewObjective,
      status: 'running',
    };
    assignmentRepo.create(reviewAssignment, runId);
    this.ctx.onProgress?.(`[${task.id}] Independent review by ${reviewer.name}...`);

    // Read-only by contract: the reviewer may inspect but never mutate.
    const reviewTask: Task = {
      ...task,
      contract: {
        ...task.contract,
        completionMode: 'review',
        forbiddenChanges: ['*'],
        objective: reviewObjective,
      },
    };

    try {
      const result = await executeGovernedAssignment({
        runId,
        baseCommit: candidateCommit,
        repoRoot: this.ctx.repoRoot,
        originalUserRequest: this.ctx.originalUserRequest,
        priorContext: this.ctx.priorContext,
        userGuidance: this.ctx.userGuidance,
        config,
        task: reviewTask,
        assignment: reviewAssignment,
        agent: reviewer,
        detached: true,
        objectiveOverride: reviewObjective,
        worktreeManager,
        workspaceRepo: this.ctx.workspaceRepo,
        assignmentRepo,
        executionRepo: this.ctx.executionRepo,
        eventRepo,
        interactionGateway: this.ctx.interactionGateway,
        activityTracker: this.ctx.activityTracker,
        streamBus: this.ctx.streamBus,
        // Deliberately outside the concurrency pool: the implementer's slot is
        // still held, so waiting for another slot here could deadlock.
        graph: this.ctx.graph,
        communicationBus: this.ctx.communicationBus,
        sessionRegistry: this.ctx.sessionRegistry,
        abortSignal: this.ctx.abortSignal,
      });

      const review = parseReviewVerdict(result.output);
      if (!result.success && review.verdict === 'missing') {
        const reason = `reviewer ${reviewer.name} failed to produce a review (${result.message ?? 'no output'})`;
        eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'DUAL_REVIEW_UNAVAILABLE',
          payload: { taskId: task.id, reviewerId: reviewer.id, reason, policy: block ? 'block' : 'skip' },
          timestamp: new Date(),
        });
        return { decision: 'unavailable', reason, block };
      }

      if (review.verdict === 'approved') {
        eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'DUAL_REVIEW_APPROVED',
          payload: { taskId: task.id, reviewerId: reviewer.id, candidateCommit },
          timestamp: new Date(),
        });
        this.ctx.onProgress?.(`[${task.id}] Independent review approved by ${reviewer.name} ✓`);
        return { decision: 'approved' };
      }

      const findings =
        review.verdict === 'missing'
          ? `Reviewer ${reviewer.name} gave no REVIEW_VERDICT line; treated as rejected.\n${review.findings}`
          : review.findings;
      eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: task.id,
        type: 'DUAL_REVIEW_REJECTED',
        payload: { taskId: task.id, reviewerId: reviewer.id, candidateCommit, findings },
        timestamp: new Date(),
      });
      this.ctx.onProgress?.(`[${task.id}] Independent review rejected by ${reviewer.name}`);
      return { decision: 'rejected', reviewerId: reviewer.id, findings };
    } finally {
      await worktreeManager
        .removeWorktree(task.id, reviewAssignment.id, true, true)
        .catch(() => {});
    }
  }

  /**
   * Runs the project's check commands once on the unchanged code before any agent
   * is started. Agents are the expensive part of a run; if the checks cannot even
   * start here (a missing .env, a database that is down), every task would end
   * blocked after its tokens were spent. In that case the writable tasks are
   * blocked up front with the recorded evidence, so `tf fix` / `tf resume` can
   * repair the environment and run once. Checks that merely fail on the unchanged
   * code are reported and the run continues. Skipped when resuming (the checks run
   * on the kept work anyway) and when nothing explicit is configured to run.
   */
  private async preflightChecks(): Promise<SchedulerResult | undefined> {
    const { config, graph, runId, eventRepo, taskRepo, runRepo, worktreeManager, verificationRunner } = this.ctx;
    if (config.verification.preflight === false) return undefined;
    // Resuming kept work: the checks run on that work anyway. A resume that starts
    // the work over (nothing integrated, nothing kept) is a fresh start and is checked.
    const resume = this.ctx.resumeState;
    if (
      resume &&
      (resume.hasIntegratedCommits ||
        Object.keys(resume.candidates ?? {}).length > 0 ||
        Object.keys(resume.taskOutputs ?? {}).length > 0)
    ) {
      // Not measuring again, but the first run's measurement still defines "new failure".
      try {
        const meta = JSON.parse(runRepo.get(runId)?.metadataJson ?? '{}') as {
          verificationBaseline?: Record<string, CheckBaseline>;
        };
        verificationRunner.setBaseline(runId, meta.verificationBaseline);
      } catch {
        // No usable baseline: checks are judged by exit code, as before.
      }
      return undefined;
    }

    const writable = graph.getAllTasks().filter((t) => t.contract.completionMode === 'mutation');
    if (writable.length === 0) return undefined;
    const commands = [...new Set(writable.flatMap((t) => verificationCommandsForTask(t, config) ?? []))];
    if (commands.length === 0) return undefined;

    const shown = commands.map((c) => `\`${c.length > 70 ? `${c.slice(0, 69)}…` : c}\``).join(', ');
    this.ctx.onProgress?.(
      `Before any agent works, running ${shown} once on the unchanged code to make sure it can run here (a full test suite can take a minute)...`,
    );
    const probe = writable[0];
    // How each command behaves before any change: passing, or failing in which tests. The
    // agents' work is then judged on what it ADDS, not on what was already wrong.
    const baseline: Record<string, CheckBaseline> = {};
    const alreadyFailing: string[] = [];
    let environmentalNote: string | undefined;
    let blocking: { result: VerificationResult; failureClass: RecoveryFailureClass } | undefined;
    verificationRunner.setBaseline(runId, undefined);
    try {
      const wt = await worktreeManager.createWorktree(probe.id, 'preflight', this.ctx.baseCommit, { detached: true });
      try {
        for (const command of commands) {
          const outcome = await verificationRunner.verify({
            taskId: probe.id,
            runId,
            worktreePath: wt.path,
            config,
            taskType: probe.type,
            explicitCommands: [command],
            documentationOnlyChange: false,
          });
          if (outcome.passed) {
            baseline[command] = { failed: false, signatures: [] };
            continue;
          }
          const cls = this.classifyVerification(outcome.failureReason);
          const check = outcome.checks[0];
          const signatures = check?.signatures ?? [];
          // The environment lacks something (a service, a data file), but the suite RAN and
          // only some tests fail: that is a measurable starting point, not a reason to stop.
          // Those tests also cannot verify this change: one that talks to a running service
          // tests that service, not the isolated copy. Stopping is for checks that prove
          // nothing: the command cannot start, or no test executed.
          const measurable =
            cls === 'environment' &&
            signatures.length > 0 &&
            testsActuallyRan(`${check?.stdout ?? ''}\n${check?.stderr ?? ''}`);
          if (cls !== 'code_or_test' && !measurable) {
            blocking = { result: outcome, failureClass: cls };
            break;
          }
          baseline[command] = { failed: true, signatures, ...(measurable ? { environmental: true } : {}) };
          alreadyFailing.push(command);
          if (measurable) {
            const port = refusedPort(outcome.failureReason ?? '');
            environmentalNote =
              `${signatures.length} test(s) already fail here because they need something this environment does not have` +
              `${port ? ` (for example a service on port ${port})` : ''}. They are ignored, and they could not verify this change anyway: ` +
              'a test that talks to a running service tests that service, not the isolated copy. Only new failures will count.';
          }
        }
      } finally {
        await worktreeManager.removeWorktree(probe.id, 'preflight', true, false).catch(() => undefined);
      }
    } catch (err) {
      // A preflight that cannot be set up must never block the run by itself.
      this.ctx.onProgress?.(`Preflight skipped: ${(err as Error).message}`);
      return undefined;
    }

    if (!blocking) {
      runRepo.mergeMetadata(runId, { verificationBaseline: baseline });
      verificationRunner.setBaseline(runId, baseline);
      eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        type: 'PREFLIGHT_PASSED',
        payload: { commands, alreadyFailing },
        timestamp: new Date(),
      });
      if (environmentalNote) {
        this.ctx.onProgress?.(`⚠ ${environmentalNote}`);
      } else if (alreadyFailing.length === 0) {
        this.ctx.onProgress?.('✔ The project\'s checks run in this environment.');
      } else {
        const known = alreadyFailing.reduce((n, c) => n + (baseline[c].signatures.length || 0), 0);
        this.ctx.onProgress?.(
          known > 0
            ? `⚠ ${known} failure(s) already exist on the unchanged code. They will not count against the agents' work: only new failures will.`
            : '⚠ Some of the project\'s checks already fail on the unchanged code, and their output has no failure list to compare, so they will not prove the agents\' work. Continuing.',
        );
      }
      return undefined;
    }

    const { result, failureClass } = blocking;
    const reason = result.failureReason?.split('\n')[0] ?? 'The project\'s checks cannot run in this environment';
    eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'PREFLIGHT_BLOCKED',
      payload: { commands, failureClass, reason, evidence: result.failureReason },
      timestamp: new Date(),
    });
    for (const task of writable) {
      eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: task.id,
        type: 'TASK_RECOVERY_BLOCKED',
        payload: {
          taskId: task.id,
          phase: 'verification',
          failureClass,
          reason,
          evidence: result.failureReason,
          action: 'block',
          attempt: 0,
          retriesRemaining: 0,
          preflight: true,
        },
        timestamp: new Date(),
      });
      this.noteTaskFailure(task, 'verification', `Preflight: ${reason}`);
      graph.updateTaskStatus(task.id, 'blocked');
      taskRepo.updateStatus(task.id, 'blocked');
    }
    this.ctx.onProgress?.(
      '✗ The project\'s checks cannot run in this environment. Stopped before any agent started, so no tokens were spent.',
    );
    runRepo.updateStatus(runId, 'failed');
    return {
      runId,
      status: 'failed',
      tasksCompleted: 0,
      tasksFailed: writable.length,
      error: `The project's checks cannot run in this environment (${reason}). Nothing was spent on agents.`,
    };
  }

  async run(): Promise<SchedulerResult> {
    const { runId, graph, eventRepo, runRepo, abortSignal, baseCommit } = this.ctx;

    eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'TASK_STARTED',
      payload: { message: 'Deterministic scheduler initiated' },
      timestamp: new Date(),
    });

    const blockedByPreflight = await this.preflightChecks();
    if (blockedByPreflight) return blockedByPreflight;

    // Main scheduling loop
    const runningPromises = new Map<string, Promise<void>>();
    let budgetStop: { spent: number; budget: number } | undefined;
    let budgetWarned = false;

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

      // Token budget: checked between task starts. Work already running is not
      // killed (that would leave half-finished changes), so a run can overshoot
      // by what was in flight; nothing new is started past the cap.
      if (this.ctx.tokenBudget && this.ctx.tokensSpent) {
        const spent = this.ctx.tokensSpent();
        const budget = this.ctx.tokenBudget;
        if (spent >= budget) {
          budgetStop = { spent, budget };
          eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            type: 'TOKEN_BUDGET_REACHED',
            payload: { spent, budget },
            timestamp: new Date(),
          });
          this.ctx.onProgress?.(
            `Token budget reached: ${spent.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens. Not starting new tasks; finishing the ones already running.`,
          );
          break;
        }
        if (!budgetWarned && spent >= budget * 0.8) {
          budgetWarned = true;
          this.ctx.onProgress?.(
            `Token usage at ${Math.round((spent / budget) * 100)}% of the ${budget.toLocaleString('en-US')} budget.`,
          );
        }
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
          const allowedWriters = allowedWritersForTask(task, this.ctx.config);
          const ownershipBlocked = allowedWriters !== undefined;
          this.ctx.onProgress?.(
            ownershipBlocked
              ? `[${task.id}] ✗ Task is BLOCKED: no healthy agent is authorized for scope ${task.contract.allowedScope.join(', ')}. Allowed writers: ${allowedWriters.size > 0 ? [...allowedWriters].join(', ') : '(none after policy intersection)'}.`
              : `[${task.id}] ✗ No healthy coding agent is currently available; task will not be sent to a known-unavailable provider.`,
          );
          this.noteTaskFailure(
            task,
            'staffing',
            ownershipBlocked
              ? `No healthy agent is authorized to write ${task.contract.allowedScope.join(', ')} (ownership policy)`
              : 'No healthy coding agent was available (all unavailable or out of quota)',
          );
          graph.updateTaskStatus(task.id, ownershipBlocked ? 'blocked' : 'failed');
          this.ctx.taskRepo.updateStatus(task.id, ownershipBlocked ? 'blocked' : 'failed');
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

    await Promise.all(this.pendingPreserves);
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
      errorMessage = budgetStop
        ? `Token budget reached (${budgetStop.spent.toLocaleString('en-US')} of ${budgetStop.budget.toLocaleString('en-US')} tokens); the remaining tasks were not started.`
        : `Tasks not all integrated: completed=${tasksCompleted}, failed=${tasksFailed}, allCompleted=${graph.isAllCompleted()}`;
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
        const reusableTeamWork = this.reusableCandidate(task);
        const res = reusableTeamWork
          ? await this.reuseCandidate(task, reusableTeamWork, collabAsgnId)
          : await executor(executionTask, taskScopedContext);
        if (!res.success) {
          const teamReason =
            ((res as { output?: string; message?: string }).output ??
              (res as { message?: string }).message ??
              '')
              .split('\n')
              .map((line) => line.trim())
              .find((line) => line.length > 0) ?? 'the team did not produce a successful result';
          if ((res as { budgetStopped?: boolean }).budgetStopped) {
            // Not a failure of the work: the run hit its token cap. Keep what the team made
            // and let the main loop stop the run with the budget reason.
            const partial = (res as { commitHash?: string }).commitHash;
            if (partial && partial !== taskBaseCommit) {
              this.preserveCandidate(task, {
                commit: partial,
                phase: 'collaboration',
                failureClass: 'code_or_test',
                reason: 'The run reached its token cap before the team finished',
              });
            }
            this.ctx.eventRepo.append({
              id: `evt-${randomUUID()}`,
              runId,
              type: 'TOKEN_BUDGET_REACHED',
              payload: { spent: this.ctx.tokensSpent?.() ?? 0, budget: this.ctx.tokenBudget ?? 0, taskId: task.id },
              timestamp: new Date(),
            });
            this.noteTaskFailure(task, 'collaboration', 'The run reached its token cap before the team finished');
            graph.updateTaskStatus(task.id, 'failed');
            taskRepo.updateStatus(task.id, 'failed');
            graph.updateTaskStatus(task.id, 'blocked');
            taskRepo.updateStatus(task.id, 'blocked');
            return;
          }
          this.ctx.onProgress?.(`[${task.id}] ✗ Team execution failed: ${teamReason}`);
          this.noteTaskFailure(task, 'collaboration', teamReason);
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
            explicitCommands:
              task.contract.verification?.commands ??
              verificationCommandsForTask(task, config) ??
              [],
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
          this.noteTaskFailure(
            task,
            'completion',
            `Completion gate rejected the team result: ${collabGate.evidence.explanation || collabGate.failureReason}`,
          );
          this.preserveCandidate(task, {
            commit: res.commitHash,
            phase: 'completion',
            failureClass: 'code_or_test',
            reason: `Completion gate rejected the team result: ${collabGate.evidence.explanation || collabGate.failureReason}`,
          });
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
          this.recordTaskOutput(task.id, collabOutput);
        }

        // Verification. Report/review contracts are validated by CompletionGate
        // and must not pay the cost of build/lint/test checks for a repository
        // they were explicitly forbidden to modify.
        graph.updateTaskStatus(task.id, 'verification');
        taskRepo.updateStatus(task.id, 'verification');

        const collabScopeViolations = await this.findScopeViolations(
          task,
          res.commitHash,
          verifyPath,
        );
        if (collabScopeViolations.length > 0) {
          this.ctx.onProgress?.(
            `[${task.id}] Collaborative task BLOCKED: changes outside the allowed scope (${task.contract.allowedScope.join(', ')}): ${collabScopeViolations.slice(0, 10).join(', ')}`,
          );
          this.noteTaskFailure(
            task,
            'scope',
            `Changed files outside the allowed scope (${task.contract.allowedScope.join(', ')}): ${collabScopeViolations.slice(0, 10).join(', ')}`,
          );
          this.preserveCandidate(task, {
            commit: res.commitHash,
            phase: 'verification',
            failureClass: 'code_or_test',
            reason: `Changed files outside the allowed scope: ${collabScopeViolations.slice(0, 10).join(', ')}`,
          });
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

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
                explicitCommands: verificationCommandsForTask(task, config),
                documentationOnlyChange: await this.isDocumentationOnly(task, res.commitHash, verifyPath),
              })
            : ({ passed: true, checks: [] } as VerificationResult));


        if (!verResult.passed) {
          const failureClass = this.classifyVerification(verResult.failureReason);
          const rework = recoveryConsumesRework(failureClass)
            ? taskRepo.incrementRework(task.id)
            : task.reworkCount;
          this.ctx.onProgress?.(
            failureClass === 'verification_configuration'
              ? `[${task.id}] Collaborative task BLOCKED: verification is not configured for this scope (add verification.commands to .taskforge/config.yaml; run "tf init" to generate it).`
              : `[${task.id}] Collaborative verification failed: ${verResult.failureReason} (rework ${rework}/${config.verification.maxReworkCycles})`,
          );
          this.noteTaskFailure(
            task,
            'verification',
            failureClass === 'verification_configuration'
              ? 'Verification is not configured for this scope: add verification.commands to .taskforge/config.yaml (run "tf init" to generate it).'
              : `Verification failed: ${verResult.failureReason ?? 'unknown reason'}`,
          );
          this.preserveCandidate(task, {
            commit: res.commitHash,
            phase: 'verification',
            failureClass,
            reason: verResult.failureReason?.split('\n')[0] ?? 'Verification failed',
            evidence: verResult.failureReason,
          });
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }

        // Independent review for sensitive tasks (opt-in dual-review gate).
        const collabReview = await this.runDualReviewGate(task, {
          implementerAgentIds: [],
          candidateCommit: res.commitHash,
          taskBaseCommit,
        });
        if (
          collabReview.decision === 'rejected' ||
          (collabReview.decision === 'unavailable' && collabReview.block)
        ) {
          this.ctx.onProgress?.(
            collabReview.decision === 'rejected'
              ? `[${task.id}] Collaborative task BLOCKED: independent review rejected the change.`
              : `[${task.id}] Collaborative task BLOCKED: dual review is required but unavailable (${collabReview.reason}).`,
          );
          this.noteTaskFailure(
            task,
            'review',
            collabReview.decision === 'rejected'
              ? `Independent review by ${collabReview.reviewerId} rejected the change: ${collabReview.findings}`
              : `Dual review is required but unavailable: ${collabReview.reason}`,
          );
          this.preserveCandidate(task, {
            commit: res.commitHash,
            phase: 'review',
            failureClass: collabReview.decision === 'rejected' ? 'code_or_test' : 'policy',
            reason:
              collabReview.decision === 'rejected'
                ? 'Independent review rejected the change'
                : `Dual review is required but unavailable: ${collabReview.reason}`,
            evidence: collabReview.decision === 'rejected' ? collabReview.findings : undefined,
          });
          graph.updateTaskStatus(task.id, 'failed');
          taskRepo.updateStatus(task.id, 'failed');
          graph.updateTaskStatus(task.id, 'blocked');
          taskRepo.updateStatus(task.id, 'blocked');
          return;
        }
        if (collabReview.decision === 'unavailable') {
          this.ctx.onProgress?.(
            `[${task.id}] ⚠ Dual review skipped by policy (onNoIndependentReviewer: skip): ${collabReview.reason}`,
          );
        }

        graph.updateTaskStatus(task.id, 'verified');
        taskRepo.updateStatus(task.id, 'verified');
        if (runAutomatedVerification) {
          this.ctx.onProgress?.(`[${task.id}] Verified successfully ✓`);
        } else {
          this.ctx.onProgress?.(`[${task.id}] Report completion validated ✓`);
        }

        if (res.commitHash && res.commitHash !== taskBaseCommit) {
          // A team that continued from kept work built its commit on that work, so the
          // commit only holds the difference from it. The run branch does not have the
          // kept work: integrate the full delta from where the task started, exactly as
          // a single agent's result is (see commitForIntegration).
          const commitToIntegrate = await this.commitForIntegration(task, res.commitHash, verifyPath);
          if (commitToIntegrate) {
            try {
              await integrationService.integrateTaskCommit({
                runId,
                taskId: task.id,
                commitHash: commitToIntegrate,
                baseCommit,
              });
            } catch (err) {
              if (!(err instanceof IntegrationError)) throw err;
              // Do not lose the work or end the run on a raw git error: keep it and block
              // the task with what conflicted, so it can be continued.
              const reason = "The team's result conflicts with changes already on the run branch";
              this.ctx.onProgress?.(`[${task.id}] ✗ ${reason}. The work is kept.`);
              this.noteTaskFailure(task, 'integration', `${reason}: ${err.message.split('\n')[0]}`);
              this.preserveCandidate(task, {
                commit: res.commitHash,
                phase: 'completion',
                failureClass: 'code_or_test',
                reason,
                evidence: err.message,
              });
              graph.updateTaskStatus(task.id, 'failed');
              taskRepo.updateStatus(task.id, 'failed');
              graph.updateTaskStatus(task.id, 'blocked');
              taskRepo.updateStatus(task.id, 'blocked');
              return;
            }
            this.recordIntegratedCommit(task.id);
          }
        }

        graph.updateTaskStatus(task.id, 'integrated');
        taskRepo.updateStatus(task.id, 'integrated');
        this.clearCandidate(task.id);
        return;
      } finally {
        await this.ctx.worktreeManager.removeWorktree(task.id, collabAsgnId, true, true).catch(() => {});
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
      const reusableWork = this.reusableCandidate(task);
      const govResult = reusableWork
        ? await this.reuseCandidate(task, reusableWork, assignmentId)
        : await executeGovernedAssignment({
        runId,
        baseCommit: taskBaseCommit,
        repoRoot: this.ctx.repoRoot,
        originalUserRequest: this.ctx.originalUserRequest,
        priorContext: this.ctx.priorContext,
        userGuidance: this.ctx.userGuidance,
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
          this.noteTaskFailure(task, 'collaboration', `Emergent collaboration rejected: maxAgentsPerTask limit (${maxAgents}) reached`);
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
          this.noteTaskFailure(task, 'collaboration', 'Emergent collaboration rejected: no suitable alternative agent was available');
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
          this.noteTaskFailure(task, 'collaboration', `Emergent collaboration delayed: no concurrency slot for ${candidateAgent.name}`);
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
          priorContext: this.ctx.priorContext,
        userGuidance: this.ctx.userGuidance,
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
          this.noteTaskFailure(
            task,
            'collaboration',
            `Emergent collaborator ${candidateAgent.name} failed: ${newGovResult.message ?? 'no details'}`,
          );
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
        failureClass: classifyExecutionFailure(
          govResult.completionReason,
          agentResult.output,
        ),
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
        explicitCommands:
          task.contract.verification?.commands ??
          verificationCommandsForTask(task, config) ??
          [],
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
        this.noteTaskFailure(task, 'completion', `A required action was denied by policy: ${failMsg}`);
        graph.updateTaskStatus(task.id, 'failed');
        taskRepo.updateStatus(task.id, 'failed');
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }

      if (task.type === 'review' && gateResult.failureReason === 'ACCEPTANCE_NOT_MET') {
        this.noteTaskFailure(task, 'completion', `Review acceptance criteria were not met: ${failMsg}`);
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
        failureClass: classifyCompletionFailure(
          gateResult.failureReason,
          [gateResult.evidence.explanation, agentResult.output].filter(Boolean).join('\n'),
        ),
        reason: describeCompletionFailure(gateResult.failureReason),
        evidence: [gateResult.evidence.explanation, agentResult.output].filter(Boolean).join('\n'),
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
      this.recordTaskOutput(task.id, agentResult.output);
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

      const scopeViolations = await this.findScopeViolations(
        task,
        agentResult.commitHash,
        wt.path,
      );
      if (scopeViolations.length > 0) {
        const shown = scopeViolations.slice(0, 10).join(', ');
        this.ctx.onProgress?.(
          `[${task.id}] ✗ Changes outside the allowed scope (${task.contract.allowedScope.join(', ')}): ${shown}`,
        );
        await this.recoverTask(task, {
          agentId,
          phase: 'verification',
          failureClass: 'code_or_test',
          reason: `Modified ${scopeViolations.length} file(s) outside the allowed scope`,
          evidence: `Allowed scope: ${task.contract.allowedScope.join(', ')}\nFiles outside scope (revert these, keep changes inside the scope):\n${scopeViolations.map((f) => `- ${f}`).join('\n')}`,
          candidateCommit: agentResult.commitHash,
          assignmentId,
        });
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }

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
              explicitCommands: verificationCommandsForTask(task, config),
              documentationOnlyChange: await this.isDocumentationOnly(
                task,
                agentResult.commitHash,
                wt.path,
              ),
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
          failureClass: this.classifyVerification(
            verResult.failureReason,
            verificationEvidence(verResult.checks),
          ),
          reason: verResult.failureReason ?? 'Automated verification failed',
          evidence: verificationEvidence(verResult.checks),
          candidateCommit: agentResult.commitHash,
          assignmentId,
        });
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }

      // 4b. Independent review for sensitive tasks (opt-in dual-review gate).
      const review = await this.runDualReviewGate(task, {
        implementerAgentIds: [agentId],
        candidateCommit: agentResult.commitHash,
        taskBaseCommit,
      });
      if (review.decision === 'rejected') {
        await this.recoverTask(task, {
          agentId,
          phase: 'review',
          failureClass: 'code_or_test',
          reason: `Independent review by ${review.reviewerId} rejected the change`,
          evidence: review.findings,
          candidateCommit: agentResult.commitHash,
          assignmentId,
        });
        await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
        return;
      }
      if (review.decision === 'unavailable') {
        if (review.block) {
          await this.recoverTask(task, {
            agentId,
            phase: 'review',
            failureClass: 'policy',
            reason: `Dual review is required but unavailable: ${review.reason}`,
            candidateCommit: agentResult.commitHash,
            assignmentId,
          });
          await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
          return;
        }
        this.ctx.onProgress?.(
          `[${task.id}] ⚠ Dual review skipped by policy (onNoIndependentReviewer: skip): ${review.reason}`,
        );
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
        const commitToIntegrate = await this.commitForIntegration(
          task,
          agentResult.commitHash,
          wt.path,
        );
        if (commitToIntegrate) {
          try {
            await integrationService.integrateTaskCommit({
              runId,
              taskId: task.id,
              commitHash: commitToIntegrate,
              baseCommit,
            });
          } catch (err) {
            if (!(err instanceof IntegrationError)) throw err;
            this.ctx.onProgress?.(
              `[${task.id}] ✗ The result conflicts with changes already on the run branch. The work is kept.`,
            );
            await this.recoverTask(task, {
              agentId,
              phase: 'completion',
              failureClass: 'code_or_test',
              reason: 'The result conflicts with changes already on the run branch',
              evidence: err.message,
              candidateCommit: agentResult.commitHash,
              assignmentId,
            });
            await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});
            return;
          }
          this.recordIntegratedCommit(task.id);
        }
        this.ctx.onProgress?.(`[${task.id}] Integrated successfully ✓`);
      }

      // 6. Cleanup: remove assignment worktree and delete intermediate branch
      await worktreeManager.removeWorktree(task.id, assignmentId, true, true).catch(() => {});

      graph.updateTaskStatus(task.id, 'integrated');
      taskRepo.updateStatus(task.id, 'integrated');
      this.recoveryIncidentsByTask.delete(task.id);
      this.recoveryBaseCommitByTask.delete(task.id);
      this.clearCandidate(task.id);
    } finally {
      this.ctx.activityTracker?.completeAssignment(assignmentId);
    }
  }
}
