import { randomUUID } from 'node:crypto';
import {
  TaskForgeConfig,
  loadConfig,
  AgentRole,
  CollaborationMode,
  CollaborationProposal,
  generateRunId,
  detectExecutionIntent,
  mostRestrictiveIntent,
  decisionFromJudgement,
  ExecutionIntentDecision,
  getGlobalStateDatabasePath,
  AgentStreamBus,
} from '@taskforge/shared';
import {
  TaskForgeDatabase,
  RunRepository,
  GoalRepository,
  TaskRepository,
  AssignmentRepository,
  ExecutionRepository,
  EventRepository,
  VerificationRepository,
  WorkspaceRepository,
  InteractionRepository,
  AgentAvailabilityRepository,
} from '@taskforge/persistence';
import { GitService, WorktreeManager, parseAgeSpec } from '@taskforge/workspace';
import {
  AgentRegistry,
  AgentDetector,
  FakeAgent,
  AgentActivityTracker,
  AgentQuotaTracker,
} from '@taskforge/agents';
import { TaskGraph, Goal, Task } from '@taskforge/core';
import {
  HeuristicPlanner,
  normalizeGraphForExecutionIntent,
  enforceLightweightReadOnlyPlanInvariant,
} from '@taskforge/planner';
import { NegotiationManager } from '@taskforge/negotiation';
import {
  StaticRoutingProvider,
  AgentSelector,
  RoutingProvider,
  RoutingDecision,
  RouterQualityGuard,
} from '@taskforge/router';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService, DeliveryService, GitHubWorkflowService } from '@taskforge/integration';
import {
  createGitWorkflowStrategy,
  detectWorkflowSuggestion,
  reconcileTargetBranch,
  RepositoryContext,
} from '@taskforge/git-workflow';
import { InteractionGateway } from '@taskforge/execution';
import {
  DeterministicScheduler,
  SchedulerResult,
  SchedulerContext,
  SchedulerResumeState,
} from './deterministic-scheduler.js';
import { executeExecutionTeam } from './execution-team.js';
import { applyTaskIdRemap, planTaskIdRemap } from './task-id-allocation.js';
import type { PreservedCandidate } from './task-recovery.js';
import { allowedWritersForTask } from './task-policy.js';
import { CommunicationBus, EscalationHandler, SessionRegistry } from '@taskforge/collaboration';
import {
  ExecutionUsageEstimator,
  TelemetryCollector,
  UsageCalibrationEngine,
} from '@taskforge/telemetry';

export interface OrchestratorOptions {
  repoRoot: string;
  config?: TaskForgeConfig;
  agentRegistry?: AgentRegistry;
  database?: TaskForgeDatabase;
  availabilityDatabase?: TaskForgeDatabase;
  planner?: import('@taskforge/core').Planner;
  negotiator?: NegotiationManager;
  router?: RoutingProvider;
  agentSelector?: AgentSelector;
  gitService?: GitService;
  worktreeManager?: WorktreeManager;
  verificationRunner?: VerificationRunner;
  integrationService?: IntegrationService;
  deliveryService?: DeliveryService;
  githubWorkflowService?: GitHubWorkflowService;
  interactionGateway?: InteractionGateway;
  activityTracker?: AgentActivityTracker;
  streamBus?: AgentStreamBus;
  communicationBus?: CommunicationBus;
  sessionRegistry?: SessionRegistry;
  escalationHandler?: EscalationHandler;
  telemetryCollector?: TelemetryCollector;
}

function hasIntentJudge(
  planner: unknown,
): planner is { judgeExecutionIntent(request: string): Promise<import('@taskforge/shared').ModelIntentJudgement | undefined> } {
  return typeof (planner as { judgeExecutionIntent?: unknown })?.judgeExecutionIntent === 'function';
}

export interface RunOptions {
  runId?: string;
  baseCommit?: string;
  preplannedGraph?: TaskGraph;
  fakeFallback?: boolean;
  onProgress?: (message: string) => void;
  abortSignal?: AbortSignal;
  activityTracker?: AgentActivityTracker;
  streamBus?: AgentStreamBus;
  /** resume only: ignore work kept from blocked tasks and start those tasks over. */
  freshStart?: boolean;
  /** Rendered output of an earlier run the request refers to (see run-context.ts). */
  priorContext?: { runId: string; text: string; chars: number };
  /**
   * The intent already settled for this request (the shell decides it before
   * showing the plan). It is combined with the deterministic reading and can
   * only make the run more restrictive.
   */
  executionIntent?: ExecutionIntentDecision;
  /** Token cap for this run; overrides `execution.tokenBudget` (on resume it is the new total cap). */
  tokenBudget?: number;
}

export interface OrchestrationResult {
  runId: string;
  goalId: string;
  status: 'completed' | 'failed' | 'cancelled';
  tasksCompleted: number;
  tasksFailed: number;
  integrationBranch?: string;
  taskOutputs?: Record<string, string>;
  durationMs: number;
  graph: TaskGraph;
  error?: string;
  schedulerResult: SchedulerResult;
  executionIntent: ExecutionIntentDecision;
}

const REVIEWER_ROLES: ReadonlySet<AgentRole> = new Set([
  'reviewer',
  'architecture_reviewer',
  'critic',
  'security_reviewer',
  'tester',
]);

/**
 * Preflight can recommend any number of roles; forcing 'pair' regardless of
 * count silently dropped every agent beyond the first two in
 * executeExecutionTeam. Pick the strategy that actually matches the shape
 * of what was requested.
 */
function collaborationModeFor(requestedRoles: AgentRole[]): CollaborationMode {
  if (requestedRoles.length <= 2) return 'pair';
  const implementerCount = requestedRoles.filter((r) => r === 'implementer').length;
  const allReviewOrImplement = requestedRoles.every(
    (r) => r === 'implementer' || REVIEWER_ROLES.has(r),
  );
  if (implementerCount === 1 && allReviewOrImplement) return 'review';
  return 'collaborative';
}

export class RunOrchestrator {
  private repoRoot: string;
  private config: TaskForgeConfig;
  private db: TaskForgeDatabase;
  private agentRegistry: AgentRegistry;
  private planner: import('@taskforge/core').Planner;
  private negotiator: NegotiationManager;
  private router: RoutingProvider;
  private agentSelector: AgentSelector;
  private gitService: GitService;
  private worktreeManager: WorktreeManager;
  private verificationRunner: VerificationRunner;
  private integrationService: IntegrationService;
  private deliveryService: DeliveryService;
  private githubWorkflowService: GitHubWorkflowService;

  private runRepo: RunRepository;
  private goalRepo: GoalRepository;
  private taskRepo: TaskRepository;
  private assignmentRepo: AssignmentRepository;
  private executionRepo: ExecutionRepository;
  private eventRepo: EventRepository;
  private verificationRepo: VerificationRepository;
  private workspaceRepo: WorkspaceRepository;
  private interactionRepo: InteractionRepository;
  private interactionGateway: InteractionGateway;
  private communicationBus: CommunicationBus;
  private sessionRegistry: SessionRegistry;
  private escalationHandler: EscalationHandler;
  private activityTracker?: AgentActivityTracker;
  private streamBus?: AgentStreamBus;
  private telemetry: TelemetryCollector;
  private usageCalibration: UsageCalibrationEngine;
  private workflowSuggestionShown = false;

  constructor(options: OrchestratorOptions) {
    this.repoRoot = options.repoRoot;
    this.activityTracker = options.activityTracker;
    this.streamBus = options.streamBus;
    this.config = options.config ?? loadConfig();
    this.db = options.database ?? new TaskForgeDatabase(this.config.execution.databasePath);
    const availabilityDb =
      options.availabilityDatabase ??
      (options.database ? options.database : new TaskForgeDatabase(getGlobalStateDatabasePath()));
    const globalAvailability = new AgentAvailabilityRepository(availabilityDb);
    if (availabilityDb !== this.db) {
      globalAvailability.mergeFrom(new AgentAvailabilityRepository(this.db));
    }
    AgentQuotaTracker.getInstance().configureStore(globalAvailability);

    this.runRepo = new RunRepository(this.db);
    this.goalRepo = new GoalRepository(this.db);
    this.taskRepo = new TaskRepository(this.db);
    this.assignmentRepo = new AssignmentRepository(this.db);
    this.executionRepo = new ExecutionRepository(this.db);
    this.eventRepo = new EventRepository(this.db);
    this.verificationRepo = new VerificationRepository(this.db);
    this.workspaceRepo = new WorkspaceRepository(this.db);
    this.interactionRepo = new InteractionRepository(this.db);
    this.telemetry = options.telemetryCollector ?? new TelemetryCollector(this.db);
    this.usageCalibration = new UsageCalibrationEngine(this.db);

    this.interactionGateway =
      options.interactionGateway ??
      new InteractionGateway({
        config: this.config,
        interactionRepo: this.interactionRepo,
      });

    this.sessionRegistry = options.sessionRegistry ?? new SessionRegistry();
    this.communicationBus =
      options.communicationBus ??
      new CommunicationBus(
        this.db,
        this.eventRepo,
        {
          maxMessagesPerRound: this.config.collaboration?.maxMessagesPerRound,
          maxRounds: this.config.collaboration?.maxRounds,
        },
        this.sessionRegistry,
      );
    this.escalationHandler =
      options.escalationHandler ??
      new EscalationHandler(this.eventRepo);

    this.agentRegistry =
      options.agentRegistry ??
      new AgentRegistry(true, this.config.agents);
    this.planner = options.planner ?? new HeuristicPlanner();
    this.negotiator =
      options.negotiator ?? new NegotiationManager(undefined, this.eventRepo, this.db);
    this.router = options.router ?? new StaticRoutingProvider();
    this.agentSelector =
      options.agentSelector ??
      new AgentSelector(this.agentRegistry, {
        selectionHistory: this.assignmentRepo,
      });

    this.gitService = options.gitService ?? new GitService(this.repoRoot);
    this.worktreeManager =
      options.worktreeManager ??
      new WorktreeManager(
        this.repoRoot,
        this.config.execution.worktreesDir,
        this.config.execution.worktreeLinks,
      );
    this.verificationRunner =
      options.verificationRunner ?? new VerificationRunner(this.verificationRepo, this.eventRepo);
    this.integrationService =
      options.integrationService ??
      new IntegrationService(
        this.repoRoot,
        this.gitService,
        this.worktreeManager,
        this.verificationRunner,
        this.eventRepo,
      );
    this.deliveryService =
      options.deliveryService ??
      new DeliveryService(this.repoRoot, this.gitService, this.runRepo, this.eventRepo);
    this.githubWorkflowService =
      options.githubWorkflowService ?? new GitHubWorkflowService(this.db, this.repoRoot);
  }

  public getInteractionGateway(): InteractionGateway {
    return this.interactionGateway;
  }

  async run(goalDescription: string, options: RunOptions = {}): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const runId = options.runId ?? generateRunId();
    options.onProgress?.(`Starting TaskForge orchestrator run: ${runId}`);

    await this.gitService.ensureLocalExclude('.taskforge/');

    const autoPrune = this.config.execution.autoPruneOlderThan;
    if (autoPrune) {
      const report = await this.worktreeManager
        .pruneStale({ olderThanMs: parseAgeSpec(autoPrune) })
        .catch(() => undefined);
      const removed = report
        ? report.worktrees.length + report.directories.length + report.branches.length
        : 0;
      if (removed > 0) {
        options.onProgress?.(
          `Auto-prune: removed ${removed} stale worktree/branch artifact(s) older than ${autoPrune}`,
        );
      }
    }

    const baseCommit = options.baseCommit ?? (await this.gitService.getHeadCommit());
    const baseBranch = await this.gitService
      .getStatus(this.repoRoot)
      .then((s) => s.currentBranch)
      .catch(() => 'main');

    // 1. Create Goal
    const goalRecord = this.goalRepo.create({
      id: `goal-${Date.now()}-${randomUUID().slice(0, 6)}`,
      description: goalDescription,
      repository: this.repoRoot,
      constraints: [],
      acceptanceCriteria: [],
    });

    const goal: Goal = {
      id: goalRecord.id,
      description: goalRecord.description,
      repository: goalRecord.repository,
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(goalRecord.createdAt),
    };

    // Execution intent is authoritative and must be known before planning.
    // Planning is an advisory interpretation layer; it is never allowed to
    // silently upgrade a read-only user request into implementation work.
    // The deterministic patterns know a few languages; the planner model reads
    // the rest. The two readings are combined and the stricter one wins.
    let executionIntent: ExecutionIntentDecision = detectExecutionIntent(goalDescription);
    if (options.executionIntent) {
      executionIntent = mostRestrictiveIntent(executionIntent, options.executionIntent);
    } else if (hasIntentJudge(this.planner)) {
      const judgement = await this.planner.judgeExecutionIntent(goalDescription);
      if (judgement) {
        executionIntent = mostRestrictiveIntent(executionIntent, decisionFromJudgement(judgement));
      }
    }

    // 2. Create Run Record. Persist everything `resume()` needs to rebuild the
    // run later without re-planning (base commit, goal text, base branch).
    this.runRepo.create(runId, goal.id, {
      goalDescription,
      baseCommit,
      baseBranch,
      // Kept so a later `tf resume` gives the agents the same context.
      ...(options.priorContext ? { priorContext: options.priorContext } : {}),
      // Kept so a resume cannot loosen what the model-assisted reading tightened.
      executionIntent,
    });
    if (options.priorContext) {
      this.eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        type: 'CONTEXT_ATTACHED',
        payload: { fromRunId: options.priorContext.runId, chars: options.priorContext.chars },
        timestamp: new Date(),
      });
      options.onProgress?.(
        `Context from run ${options.priorContext.runId} attached (${options.priorContext.chars} chars, reference only).`,
      );
    }

    // 3. Report the intent settled above.
    options.onProgress?.(
      `Execution intent: ${executionIntent.intent} (mutation ${executionIntent.mutationAllowed ? 'allowed' : 'disabled'})`,
    );

    // 4. Planning
    options.onProgress?.('Generating structured task graph...');
    let rawGraph = options.preplannedGraph ?? (await this.planner.plan(goal));

    // Task ids must be unique across runs (see task-id-allocation.ts).
    const idRemap = planTaskIdRemap(
      rawGraph,
      {
        isTaken: (id) => this.taskRepo.idExists(id),
        maxNumericId: () => this.taskRepo.maxNumericTaskId(),
      },
      runId,
    );
    if (idRemap) {
      rawGraph = applyTaskIdRemap(rawGraph, idRemap);
      options.onProgress?.(
        `Task ids renumbered to stay unique across runs: ${[...idRemap].map(([from, to]) => `${from}→${to}`).join(', ')}`,
      );
    }

    // 5. Preflight Negotiation
    options.onProgress?.('Executing preflight contract negotiation...');
    const negotiatedGraph = await this.negotiator.negotiateGraph(rawGraph, runId);
    const invariant = enforceLightweightReadOnlyPlanInvariant(
      negotiatedGraph,
      goal,
      executionIntent,
    );
    const graph = invariant.graph;
    if (invariant.changed) {
      this.eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: graph.getAllTasks()[0]?.id,
        type: 'PLAN_INVARIANT_ENFORCED',
        payload: {
          invariant: 'lightweight_read_only_single_task',
          originalTaskCount: invariant.originalTaskCount,
          normalizedTaskCount: graph.getAllTasks().length,
          reason: invariant.reason,
        },
        timestamp: new Date(),
      });
      options.onProgress?.(
        `Plan invariant enforced: lightweight read-only overview collapsed from ${invariant.originalTaskCount} task(s) to 1 report task.`,
      );
    }

    // 5b. Normalize task contracts against the authoritative run intent.
    const intentNormalizations = normalizeGraphForExecutionIntent(graph, executionIntent);
    for (const normalization of intentNormalizations) {
      this.eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId,
        taskId: normalization.taskId,
        type: 'PLAN_INTENT_NORMALIZED',
        payload: { ...normalization },
        timestamp: new Date(),
      });
      options.onProgress?.(
        `[${normalization.taskId}] Plan intent normalized: ${normalization.originalTaskType} → ${normalization.normalizedTaskType} (${normalization.reason})`,
      );
    }

    // Persist all tasks in DB
    for (const task of graph.getAllTasks()) {
      this.taskRepo.create({
        id: task.id,
        runId,
        goalId: goal.id,
        title: task.title,
        description: task.description,
        type: task.type,
        status: task.status,
        contract: task.contract,
        dependencies: task.dependencies,
      });
    }

    return this.executeGraph({
      runId,
      goalId: goal.id,
      goalDescription,
      graph,
      baseCommit,
      baseBranch,
      executionIntent,
      options,
      startTime,
    });
  }

  /**
   * Resumes a previously interrupted, cancelled or failed run. Tasks that were
   * already integrated into the run branch are kept; every other task is reset
   * and re-executed with a fresh recovery budget. Planning and negotiation are
   * not repeated — the persisted task graph is authoritative.
   */
  /**
   * Read-only: loads everything `resume` needs and validates that the run can
   * be resumed, throwing an actionable error when it cannot.
   */
  private async prepareResume(runId: string) {
    const run = this.runRepo.get(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status === 'abandoned') {
      throw new Error(`Run ${runId} was abandoned and will not be resumed.`);
    }
    if (run.status === 'completed') {
      throw new Error(`Run ${runId} already completed; use /diff, /apply or /pr to deliver it.`);
    }

    const goal = run.goalId ? this.goalRepo.get(run.goalId) : undefined;
    const metadata = run.metadataJson ? JSON.parse(run.metadataJson) : {};
    const goalDescription: string | undefined = metadata.goalDescription ?? goal?.description;
    if (!goalDescription) throw new Error(`Run ${runId} has no recorded goal; cannot resume.`);

    const records = this.taskRepo.listByRun(runId);
    if (records.length === 0) throw new Error(`Run ${runId} has no persisted tasks; cannot resume.`);

    const integrationBranch = this.integrationService.getBranchName(runId);
    const branchExists = await this.gitService.branchExists(integrationBranch);
    let baseCommit: string | undefined = metadata.baseCommit;
    if (!baseCommit && branchExists) {
      // Runs created before checkpoints were recorded: recover the base from the run branch.
      baseCommit = await this.gitService
        .execGit(['merge-base', integrationBranch, 'HEAD'])
        .then((out) => out.trim())
        .catch(() => undefined);
    }
    if (!baseCommit) {
      throw new Error(
        `Run ${runId} was created before TaskForge recorded resume checkpoints (no base commit) and its run branch no longer exists, so it cannot be resumed. Start a new run instead.`,
      );
    }
    const baseBranch: string = metadata.baseBranch ?? 'main';

    // A task whose commit lives on the run branch is only done while that branch
    // exists (e.g. /clean removes it). Read-only report tasks produce no commit,
    // never create the branch, and lose nothing: they are always kept. Runs from
    // before commit tracking fall back to the task contract.
    const commitTaskIds: string[] | undefined = metadata.commitTaskIds;
    const mayHaveCommit = (id: string, contract: { forbiddenChanges?: string[]; completionMode?: string }) =>
      commitTaskIds
        ? commitTaskIds.includes(id)
        : !(
            contract.forbiddenChanges?.includes('*') ||
            ['report', 'review', 'verification'].includes(contract.completionMode ?? '')
          );
    const tasks: Task[] = records.map((record) => {
      const contract = JSON.parse(record.contractJson ?? '{}');
      const keep =
        record.status === 'integrated' && (branchExists || !mayHaveCommit(record.id, contract));
      const dependencies =
        record.dependencies && record.dependencies.length > 0
          ? record.dependencies
          : (contract.dependencies ?? []);
      return {
        id: record.id,
        goalId: record.goalId ?? '',
        title: record.title,
        description: record.description,
        type: record.type,
        status: keep ? 'integrated' : 'accepted',
        dependencies,
        contract,
        acceptanceCriteria: record.acceptanceCriteriaJson
          ? JSON.parse(record.acceptanceCriteriaJson)
          : (contract.acceptanceCriteria ?? []),
        reworkCount: 0,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(),
      };
    });

    const pending = tasks.filter((t) => t.status !== 'integrated');
    if (pending.length === 0) {
      throw new Error(`Run ${runId} has no pending tasks; nothing to resume.`);
    }

    return {
      run,
      goalDescription,
      metadata,
      baseCommit,
      baseBranch,
      integrationBranch,
      branchExists,
      tasks,
      pending,
    };
  }

  /**
   * Why a run cannot be resumed, or undefined when it can. Lets callers (such
   * as `tf resume` without an id) skip runs that cannot be continued instead
   * of failing on the first one they happen to find.
   */
  async checkResumable(runId: string): Promise<string | undefined> {
    try {
      await this.prepareResume(runId);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async resume(runId: string, options: RunOptions = {}): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const {
      run,
      goalDescription,
      metadata,
      baseCommit,
      baseBranch,
      integrationBranch,
      branchExists,
      tasks,
      pending,
    } = await this.prepareResume(runId);

    if (!branchExists) {
      // The integration worktree of a deleted run branch still holds the old,
      // already-applied commits; reusing it would make redone tasks conflict.
      await this.worktreeManager
        .removeWorktree(`integration-${runId}`, 'main-worker', true, true)
        .catch(() => {});
    }

    const commitTaskIds: string[] | undefined = metadata.commitTaskIds;

    // Work kept from blocked tasks (see PreservedCandidate). Only commits that
    // still exist in this repository are usable.
    const candidates: Record<string, PreservedCandidate> = {};
    if (!options.freshStart) {
      const kept = (metadata.candidates ?? {}) as Record<string, PreservedCandidate>;
      for (const task of pending) {
        const candidate = kept[task.id];
        if (!candidate?.commit) continue;
        const exists = await this.gitService
          .execGit(['cat-file', '-e', `${candidate.commit}^{commit}`])
          .then(
            () => true,
            () => false,
          );
        if (exists) candidates[task.id] = candidate;
      }
    }
    for (const task of pending) this.taskRepo.updateStatus(task.id, 'accepted');

    const graph = new TaskGraph(tasks);
    const integratedIds = tasks.filter((t) => t.status === 'integrated').map((t) => t.id);
    const hasIntegratedCommits =
      branchExists && (await this.gitService.resolveRef(integrationBranch)) !== baseCommit;

    this.runRepo.updateStatus(runId, 'running');
    this.eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'RUN_RESUMED',
      payload: { integratedTasks: integratedIds, pendingTasks: pending.map((t) => t.id) },
      timestamp: new Date(),
    });
    const kept = Object.keys(candidates);
    if (kept.length > 0) {
      options.onProgress?.(
        `Work from an earlier attempt is kept for ${kept.join(', ')}; it is reused instead of starting over (use "tf resume --fresh" to discard it).`,
      );
    }
    const behind = await this.gitService
      .execGit(['rev-list', '--count', `${baseCommit}..HEAD`])
      .then((out) => parseInt(out.trim(), 10) || 0)
      .catch(() => 0);
    if (behind > 0) {
      options.onProgress?.(
        `Note: this run started from ${baseCommit.slice(0, 7)} and the repository has moved on by ${behind} commit(s) since. The resumed work is still based on ${baseCommit.slice(0, 7)}. If the work was already applied by hand, run "tf abandon ${runId}" instead of resuming.`,
      );
    }
    options.onProgress?.(
      `Resuming run ${runId}: ${integratedIds.length} task(s) already integrated${integratedIds.length ? ` (${integratedIds.join(', ')})` : ''}, ${pending.length} to execute (${pending.map((t) => t.id).join(', ')})`,
    );
    await this.worktreeManager.prune().catch(() => {});

    if (metadata.priorContext && !options.priorContext) {
      options = { ...options, priorContext: metadata.priorContext };
    }

    return this.executeGraph({
      runId,
      goalId: run.goalId ?? '',
      goalDescription,
      graph,
      baseCommit,
      baseBranch,
      executionIntent: mostRestrictiveIntent(
        detectExecutionIntent(goalDescription),
        metadata.executionIntent as ExecutionIntentDecision | undefined,
      ),
      options,
      startTime,
      resumeState: {
        taskOutputs: (metadata.taskOutputs as Record<string, string> | undefined) ?? {},
        hasIntegratedCommits,
        commitTaskIds,
        candidates,
      },
    });
  }

  private async executeGraph(params: {
    runId: string;
    goalId: string;
    goalDescription: string;
    graph: TaskGraph;
    baseCommit: string;
    baseBranch: string;
    executionIntent: ExecutionIntentDecision;
    options: RunOptions;
    startTime: number;
    resumeState?: SchedulerResumeState;
  }): Promise<OrchestrationResult> {
    const {
      runId,
      goalId,
      goalDescription,
      graph,
      baseCommit,
      baseBranch,
      executionIntent,
      options,
      startTime,
      resumeState,
    } = params;

    // 5. Check Agent Availability / Fallback
    const detected = await AgentDetector.detect(this.agentRegistry.list());
    const hasReadyAgents = detected.some((d) => d.ready);

    if (!hasReadyAgents || options.fakeFallback) {
      if (options.fakeFallback) {
        options.onProgress?.('Deterministic execution enabled with FakeAgent.');
      } else {
        options.onProgress?.(
          'No real CLI harnesses detected; registering deterministic FakeAgent fallback.',
        );
      }
      this.config.verification.tests = false;
      this.config.verification.lint = false;
      this.config.verification.typecheck = false;
      if (!this.agentRegistry.get('fake-agent')) {
        this.agentRegistry.register(
          new FakeAgent('fake-agent', 'Fake Agent', [
            {
              writeFile: {
                path: 'taskforge-output.txt',
                content: `Task completed in run ${runId} at ${new Date().toISOString()}\n`,
              },
              gitCommitMessage: `feat: completed task in run ${runId}`,
            },
          ]),
        );
      }
    }

    // 6. Route tasks and determine staffing
    const preferredAgentMapping: Record<string, string> = {};
    const collaborativeExecutors = new Map<
      string,
      (task: Task, ctx: SchedulerContext) => Promise<{ success: boolean; commitHash?: string; output?: string; worktreePath?: string }>
    >();

    const fallbackAgent =
      this.agentRegistry.get('fake-agent') ??
      this.agentRegistry
        .list()
        .find((a) => a instanceof FakeAgent || a.id.includes('fake') || a.id.includes('test'));

    for (const task of graph.getAllTasks()) {
      if (options.fakeFallback && fallbackAgent) {
        preferredAgentMapping[task.id] = fallbackAgent.id;
        continue;
      }

      try {
        const collabReq = task.contract.metadata?.collaboration as CollaborationProposal | undefined;
        const availableAgents = await this.agentSelector.listAvailableAgentIds();
        let routingProposal: RoutingDecision;

        if (task.contract.metadata?.recommendCollaboration && collabReq?.requestedRoles?.length) {
          routingProposal = {
            strategy: collaborationModeFor(collabReq.requestedRoles),
            source: 'static',
            complexity: 'high',
            risk: 'high',
            uncertainty: 'medium',
            teamSize: collabReq.requestedRoles.length,
            roles: collabReq.requestedRoles.map((role: AgentRole) => ({
              role,
              requiredCapabilities: role === 'implementer' ? ['canWrite'] : ['canRead'],
              objective: collabReq.reason || task.contract.objective,
            })),
            communication: {
              required: true,
              initialAlignment: true,
              synthesisBeforeImplementation: false,
            },
            reason: `Preflight recommended collaboration: ${collabReq.reason}`,
          };
        } else {
          routingProposal = await this.router.route({
            task,
            availableAgents,
          });
        }

        // Single product boundary for every staffing source, including
        // preflight/emergent collaboration. Nothing bypasses fan-out economics.
        const routing = RouterQualityGuard.evaluate(routingProposal, {
          task,
          availableAgents,
        });

        const maxAgents = this.config.collaboration?.maxAgentsPerTask ?? 3;
        if (routing.roles.length > maxAgents) {
          const originalCount = routing.roles.length;
          routing.roles = routing.roles.slice(0, maxAgents);
          if (routing.teamSize > maxAgents) {
            routing.teamSize = maxAgents;
          }
          this.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'STAFFING_CAPPED',
            payload: {
              taskId: task.id,
              originalRolesCount: originalCount,
              cappedTo: maxAgents,
              reason: `collaboration.maxAgentsPerTask limit (${maxAgents}) enforced`,
            },
            timestamp: new Date(),
          });
          options.onProgress?.(
            `[${task.id}] Staffing capped from ${originalCount} to ${maxAgents} agents (collaboration.maxAgentsPerTask limit)`,
          );
        }

        this.eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId,
          taskId: task.id,
          type: 'ROUTING_DECIDED',
          payload: {
            taskId: task.id,
            strategy: routing.strategy,
            teamSize: routing.teamSize,
            roles: routing.roles.map((role) => role.role),
            reason: routing.reason,
            source: routing.source,
            fanOutAssessment: routing.fanOutAssessment,
          },
          timestamp: new Date(),
        });

        let selected = await this.agentSelector.selectAgents(routing.roles, {
          selectionKey: `${this.repoRoot}:${task.id}`,
          allowedAgentIds: allowedWritersForTask(task, this.config),
        });

        // In fakeFallback mode, if roles were requested, ensure fake agent fills them
        if (selected.length === 0 && fallbackAgent) {
          selected = routing.roles.map((r) => ({
            roleRequest: r,
            agent: fallbackAgent,
          }));
        } else if (selected.length === 1 && routing.roles.length > 1 && fallbackAgent) {
          selected.push({
            roleRequest: routing.roles[1],
            agent: fallbackAgent,
          });
        }

        if (selected.length > maxAgents) {
          selected = selected.slice(0, maxAgents);
        }

        if (selected.length > 0) {
          preferredAgentMapping[task.id] = selected[0].agent.id;

          const distinctSelectedAgents = new Set(selected.map((s) => s.agent.id));
          if (
            selected.length > 1 &&
            distinctSelectedAgents.size > 1 &&
            (routing.strategy === 'pair' ||
              routing.strategy === 'review' ||
              routing.strategy === 'collaborative' ||
              routing.strategy === 'parallel' ||
              routing.strategy === 'competitive' ||
              routing.teamSize > 1)
          ) {
            collaborativeExecutors.set(task.id, async (execTask, ctx) => {
              return executeExecutionTeam(execTask, ctx, routing, selected);
            });
          }
        } else if (fallbackAgent) {
          preferredAgentMapping[task.id] = fallbackAgent.id;
        }
      } catch {
        if (fallbackAgent) {
          preferredAgentMapping[task.id] = fallbackAgent.id;
        }
      }
    }

    // Freeze calibration at run start so every assignment baseline is
    // compared against history that existed before this run, not against
    // sibling assignments that happened to finish a few milliseconds earlier.
    const runUsageCalibration = this.usageCalibration.getTaskTypeCalibrations(
      graph.getAllTasks().map((task) => task.type),
    );

    // 7. Deterministic Scheduler
    const scheduledTasks = graph.getAllTasks();
    const isReadOnlyReportRun = scheduledTasks.every(
      (task) =>
        task.contract.completionMode === 'report' &&
        task.contract.forbiddenChanges?.includes('*'),
    );
    const schedulingLabel = isReadOnlyReportRun
      ? `Scheduling ${scheduledTasks.length} read-only task${scheduledTasks.length === 1 ? '' : 's'}...`
      : `Scheduling ${scheduledTasks.length} task${scheduledTasks.length === 1 ? '' : 's'} across worktrees...`;
    options.onProgress?.(schedulingLabel);
    const scheduler = new DeterministicScheduler({
      runId,
      baseCommit,
      repoRoot: this.repoRoot,
      originalUserRequest: goalDescription,
      priorContext: options.priorContext?.text,
      config: this.config,
      graph,
      agentRegistry: this.agentRegistry,
      preferredAgentMapping,
      collaborativeExecutors,
      worktreeManager: this.worktreeManager,
      gitService: this.gitService,
      verificationRunner: this.verificationRunner,
      integrationService: this.integrationService,
      runRepo: this.runRepo,
      taskRepo: this.taskRepo,
      assignmentRepo: this.assignmentRepo,
      executionRepo: this.executionRepo,
      eventRepo: this.eventRepo,
      workspaceRepo: this.workspaceRepo,
      interactionGateway: this.interactionGateway,
      communicationBus: this.communicationBus,
      sessionRegistry: this.sessionRegistry,
      escalationHandler: this.escalationHandler,
      activityTracker: options.activityTracker ?? this.activityTracker,
      streamBus: options.streamBus ?? this.streamBus,
      onAgentUsage: ({ task, assignment, agentId, usage }) => {
        const planned = ExecutionUsageEstimator.estimateRun({
          tasks: [task],
          originalUserRequest: goalDescription,
          assignmentCounts: { [task.id]: 1 },
          calibrationByTaskType: runUsageCalibration,
        }).expectedTokens;

        this.telemetry.recordTaskTokens({
          runId,
          taskId: task.id,
          assignmentId: assignment.id,
          agentId,
          role: assignment.role,
          modelName: usage.modelName ?? agentId,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          usageSource: usage.source,
          plannedEstimatedTokens: planned,
        });
      },
      onProgress: options.onProgress,
      abortSignal: options.abortSignal,
      tokenBudget: options.tokenBudget ?? this.config.execution.tokenBudget,
      tokensSpent: () => this.telemetry.getRunTokenTotal(runId),
      resumeState,
    });

    const schedulerResult = await scheduler.run();

    // 7. Cleanup transient worktrees
    await this.worktreeManager.prune().catch(() => {});

    // 8. Delivery gate: mark the run ready to apply, and honor the configured delivery mode.
    // A READ_ONLY_ANALYSIS run must never be offered for delivery, regardless
    // of what the scheduler produced.
    if (
      executionIntent.deliveryAllowed &&
      schedulerResult.status === 'completed' &&
      schedulerResult.integrationBranch
    ) {
      if (!this.workflowSuggestionShown) {
        this.workflowSuggestionShown = true;
        if (this.config.git.workflow === 'trunk') {
          const suggestion = await detectWorkflowSuggestion(this.gitService, this.repoRoot).catch(
            () => undefined,
          );
          if (suggestion) {
            options.onProgress?.(
              `TaskForge detected ${suggestion.reason} — this looks like GitFlow. Set git.workflow: ${suggestion.suggested} in .taskforge/config.yaml to enable it.`,
            );
          }
        }
      }

      const repoContext: RepositoryContext = {
        currentBranch: baseBranch,
        localBranches: await this.gitService.listLocalBranches(this.repoRoot).catch(() => []),
      };
      const workflowStrategy = createGitWorkflowStrategy(this.config.git);
      const configuredTarget =
        this.config.delivery.targetBranch ??
        workflowStrategy.resolveTargetBranch(repoContext, goalDescription);
      const reconciled = reconcileTargetBranch(configuredTarget, repoContext);
      const targetBranch = reconciled.branch;
      if (reconciled.adjustedFrom) {
        options.onProgress?.(
          `Delivery: target branch "${reconciled.adjustedFrom}" does not exist in this repository; using "${targetBranch}" instead (set git.targetBranch to override).`,
        );
      }
      this.deliveryService.markReady(
        runId,
        schedulerResult.integrationBranch,
        targetBranch,
        baseCommit,
      );

      if (
        this.config.delivery.mode === 'auto_apply' &&
        this.config.permissions.git.merge_main === 'allow'
      ) {
        try {
          const applied = await this.deliveryService.apply(runId);
          options.onProgress?.(`Delivery: applied to ${targetBranch} (${applied.commit.slice(0, 7)})`);
        } catch (err) {
          options.onProgress?.(`Delivery: auto-apply failed: ${(err as Error).message}`);
        }
      } else if (this.config.delivery.mode === 'pull_request') {
        try {
          const headBranch = await this.deliveryService.prepareDeliveryBranch(runId);
          const pr = await this.githubWorkflowService.createPullRequest({
            runId,
            targetBranch,
            repoRoot: this.repoRoot,
            headBranch,
          });
          if (pr.success && pr.prUrl) {
            this.deliveryService.markPrCreated(runId, pr.prUrl);
          }
          options.onProgress?.(`Delivery: ${pr.message}`);
        } catch (err) {
          options.onProgress?.(`Delivery: pull request creation failed: ${(err as Error).message}`);
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Run-level metrics belong to the orchestration boundary, not to a
    // presentation surface. This keeps interactive, headless and API-driven
    // executions equally observable.
    const efficiency = this.telemetry.getOrchestrationEfficiency(runId);
    const staffing = this.telemetry.getStaffingMetrics(runId);
    this.telemetry.recordRunMetrics({
      runId,
      durationMs,
      tasksCount: efficiency.taskCount,
      tasksCompleted: schedulerResult.tasksCompleted,
      tasksFailed: schedulerResult.tasksFailed,
      reworkCount: efficiency.reworkCount,
      escalationsCount:
        staffing.collaborationApprovedCount +
        staffing.collaborationRejectedCount +
        staffing.collaborationDelayedCount,
      firstPassRate: efficiency.firstPassRate,
    });

    options.onProgress?.(`Run finished with status ${schedulerResult.status} in ${durationMs}ms`);

    return {
      runId,
      goalId,
      status: schedulerResult.status,
      tasksCompleted: schedulerResult.tasksCompleted,
      tasksFailed: schedulerResult.tasksFailed,
      integrationBranch: schedulerResult.integrationBranch,
      taskOutputs: schedulerResult.taskOutputs,
      durationMs,
      graph,
      error: schedulerResult.error,
      schedulerResult,
      executionIntent,
    };
  }
}
