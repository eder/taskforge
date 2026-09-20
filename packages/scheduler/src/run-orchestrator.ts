import {
  TaskForgeConfig,
  loadConfig,
  AgentRole,
  CollaborationProposal,
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
} from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { AgentRegistry, AgentDetector, FakeAgent, AgentActivityTracker } from '@taskforge/agents';
import { TaskGraph, Goal, Task } from '@taskforge/core';
import { HeuristicPlanner } from '@taskforge/planner';
import { NegotiationManager } from '@taskforge/negotiation';
import {
  StaticRoutingProvider,
  AgentSelector,
  RoutingProvider,
  RoutingDecision,
} from '@taskforge/router';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService, DeliveryService, GitHubWorkflowService } from '@taskforge/integration';
import {
  createGitWorkflowStrategy,
  detectWorkflowSuggestion,
  RepositoryContext,
} from '@taskforge/git-workflow';
import { InteractionGateway } from '@taskforge/execution';
import {
  DeterministicScheduler,
  SchedulerResult,
  SchedulerContext,
} from './deterministic-scheduler.js';
import { executeExecutionTeam } from './execution-team.js';

export interface OrchestratorOptions {
  repoRoot: string;
  config?: TaskForgeConfig;
  agentRegistry?: AgentRegistry;
  database?: TaskForgeDatabase;
  planner?: HeuristicPlanner;
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
}

export interface RunOptions {
  baseCommit?: string;
  preplannedGraph?: TaskGraph;
  fakeFallback?: boolean;
  onProgress?: (message: string) => void;
  abortSignal?: AbortSignal;
  activityTracker?: AgentActivityTracker;
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
}

export class RunOrchestrator {
  private repoRoot: string;
  private config: TaskForgeConfig;
  private db: TaskForgeDatabase;
  private agentRegistry: AgentRegistry;
  private planner: HeuristicPlanner;
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
  private activityTracker?: AgentActivityTracker;
  private workflowSuggestionShown = false;

  constructor(options: OrchestratorOptions) {
    this.repoRoot = options.repoRoot;
    this.activityTracker = options.activityTracker;
    this.config = options.config ?? loadConfig();
    this.db = options.database ?? new TaskForgeDatabase(this.config.execution.databasePath);

    this.runRepo = new RunRepository(this.db);
    this.goalRepo = new GoalRepository(this.db);
    this.taskRepo = new TaskRepository(this.db);
    this.assignmentRepo = new AssignmentRepository(this.db);
    this.executionRepo = new ExecutionRepository(this.db);
    this.eventRepo = new EventRepository(this.db);
    this.verificationRepo = new VerificationRepository(this.db);
    this.workspaceRepo = new WorkspaceRepository(this.db);
    this.interactionRepo = new InteractionRepository(this.db);

    this.interactionGateway =
      options.interactionGateway ??
      new InteractionGateway({
        config: this.config,
        interactionRepo: this.interactionRepo,
      });

    this.agentRegistry = options.agentRegistry ?? new AgentRegistry();
    this.planner = options.planner ?? new HeuristicPlanner();
    this.negotiator =
      options.negotiator ?? new NegotiationManager(undefined, this.eventRepo, this.db);
    this.router = options.router ?? new StaticRoutingProvider();
    this.agentSelector = options.agentSelector ?? new AgentSelector(this.agentRegistry);

    this.gitService = options.gitService ?? new GitService(this.repoRoot);
    this.worktreeManager =
      options.worktreeManager ??
      new WorktreeManager(this.repoRoot, this.config.execution.worktreesDir);
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
    const runId = `run-${Date.now()}`;
    options.onProgress?.(`Starting TaskForge orchestrator run: ${runId}`);

    const baseCommit = options.baseCommit ?? (await this.gitService.getHeadCommit());
    const baseBranch = await this.gitService
      .getStatus(this.repoRoot)
      .then((s) => s.currentBranch)
      .catch(() => 'main');

    // 1. Create Goal
    const goalRecord = this.goalRepo.create({
      id: `goal-${Date.now()}`,
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

    // 2. Create Run Record
    this.runRepo.create(runId, goal.id);

    // 3. Planning
    options.onProgress?.('Generating structured task graph...');
    const rawGraph = options.preplannedGraph ?? (await this.planner.plan(goal));

    // 4. Preflight Negotiation
    options.onProgress?.('Executing preflight contract negotiation...');
    const graph = await this.negotiator.negotiateGraph(rawGraph, runId);

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
      });
    }

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
      try {
        const collabReq = task.contract.metadata?.collaboration as CollaborationProposal | undefined;
        let routing: RoutingDecision;

        if (task.contract.metadata?.recommendCollaboration && collabReq?.requestedRoles?.length) {
          routing = {
            strategy: 'pair',
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
        } else if (options.fakeFallback && fallbackAgent) {
          preferredAgentMapping[task.id] = fallbackAgent.id;
          continue;
        } else {
          routing = await this.router.route({
            task,
            availableAgents: this.agentRegistry.list().map((a) => a.id),
          });
        }

        let selected = await this.agentSelector.selectAgents(routing.roles);


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

        if (selected.length > 0) {
          preferredAgentMapping[task.id] = selected[0].agent.id;

          if (
            selected.length > 1 &&
            (routing.strategy === 'pair' ||
              routing.strategy === 'collaborative' ||
              routing.strategy === 'parallel' ||
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

    // 7. Deterministic Scheduler
    options.onProgress?.(`Scheduling ${graph.getAllTasks().length} tasks across worktrees...`);
    const scheduler = new DeterministicScheduler({
      runId,
      baseCommit,
      repoRoot: this.repoRoot,
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
      activityTracker: options.activityTracker ?? this.activityTracker,
      onProgress: options.onProgress,
      abortSignal: options.abortSignal,
    });

    const schedulerResult = await scheduler.run();

    // 7. Cleanup transient worktrees
    await this.worktreeManager.prune().catch(() => {});

    // 8. Delivery gate: mark the run ready to apply, and honor the configured delivery mode
    if (schedulerResult.status === 'completed' && schedulerResult.integrationBranch) {
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
      const targetBranch =
        this.config.delivery.targetBranch ??
        workflowStrategy.resolveTargetBranch(repoContext, goalDescription);
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
          const pr = await this.githubWorkflowService.createPullRequest({
            runId,
            targetBranch,
            repoRoot: this.repoRoot,
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
    options.onProgress?.(`Run finished with status ${schedulerResult.status} in ${durationMs}ms`);

    return {
      runId,
      goalId: goal.id,
      status: schedulerResult.status,
      tasksCompleted: schedulerResult.tasksCompleted,
      tasksFailed: schedulerResult.tasksFailed,
      integrationBranch: schedulerResult.integrationBranch,
      taskOutputs: schedulerResult.taskOutputs,
      durationMs,
      graph,
      error: schedulerResult.error,
      schedulerResult,
    };
  }
}
