import { TaskForgeConfig, loadConfig } from '@taskforge/shared';
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
import { AgentRegistry, AgentDetector, FakeAgent } from '@taskforge/agents';
import { TaskGraph, Goal } from '@taskforge/core';
import { HeuristicPlanner } from '@taskforge/planner';
import { NegotiationManager } from '@taskforge/negotiation';
import { StaticRoutingProvider, AgentSelector, RoutingProvider } from '@taskforge/router';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { InteractionGateway } from '@taskforge/execution';
import { DeterministicScheduler, SchedulerResult } from './deterministic-scheduler.js';

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
  interactionGateway?: InteractionGateway;
}

export interface RunOptions {
  baseCommit?: string;
  preplannedGraph?: TaskGraph;
  fakeFallback?: boolean;
  onProgress?: (message: string) => void;
}

export interface OrchestrationResult {
  runId: string;
  goalId: string;
  status: 'completed' | 'failed' | 'cancelled';
  tasksCompleted: number;
  tasksFailed: number;
  integrationBranch?: string;
  durationMs: number;
  graph: TaskGraph;
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

  constructor(options: OrchestratorOptions) {
    this.repoRoot = options.repoRoot;
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
    this.negotiator = options.negotiator ?? new NegotiationManager(undefined, this.eventRepo, this.db);
    this.router = options.router ?? new StaticRoutingProvider();
    this.agentSelector = options.agentSelector ?? new AgentSelector(this.agentRegistry);

    this.gitService = options.gitService ?? new GitService(this.repoRoot);
    this.worktreeManager =
      options.worktreeManager ?? new WorktreeManager(this.repoRoot, this.config.execution.worktreesDir);
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
  }

  public getInteractionGateway(): InteractionGateway {
    return this.interactionGateway;
  }

  async run(goalDescription: string, options: RunOptions = {}): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const runId = `run-${Date.now()}`;
    options.onProgress?.(`Starting TaskForge orchestrator run: ${runId}`);

    const baseCommit = options.baseCommit ?? (await this.gitService.getHeadCommit());

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
        options.onProgress?.('No real CLI harnesses detected; registering deterministic FakeAgent fallback.');
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
    const fallbackAgent =
      this.agentRegistry.get('fake-agent') ??
      this.agentRegistry.list().find((a) => a instanceof FakeAgent || a.id.includes('fake') || a.id.includes('test'));

    for (const task of graph.getAllTasks()) {
      if (options.fakeFallback && fallbackAgent) {
        preferredAgentMapping[task.id] = fallbackAgent.id;
        continue;
      }

      try {
        const routing = await this.router.route({
          task,
          availableAgents: this.agentRegistry.list().map((a) => a.id),
        });
        const selected = await this.agentSelector.selectAgents(routing.roles);
        if (selected.length > 0) {
          preferredAgentMapping[task.id] = selected[0].agent.id;
        }
      } catch {
        // fallback
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
      onProgress: options.onProgress,
    });

    const schedulerResult = await scheduler.run();

    // 7. Cleanup transient worktrees
    await this.worktreeManager.prune().catch(() => {});

    const durationMs = Date.now() - startTime;
    options.onProgress?.(`Run finished with status ${schedulerResult.status} in ${durationMs}ms`);

    return {
      runId,
      goalId: goal.id,
      status: schedulerResult.status,
      tasksCompleted: schedulerResult.tasksCompleted,
      tasksFailed: schedulerResult.tasksFailed,
      integrationBranch: schedulerResult.integrationBranch,
      durationMs,
      graph,
      schedulerResult,
    };
  }
}
