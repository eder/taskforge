import {
  TaskForgeConfig,
  loadConfig,
  AgentAssignment,
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
  SelectedAgentAssignment,
} from '@taskforge/router';
import { AssignmentGraph, SynthesisCoordinator } from '@taskforge/collaboration';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { InteractionGateway } from '@taskforge/execution';
import {
  DeterministicScheduler,
  SchedulerResult,
  SchedulerContext,
} from './deterministic-scheduler.js';

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
              return this.executeTeamTask(execTask, ctx, routing, selected);
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

  private async executeTeamTask(
    task: Task,
    ctx: SchedulerContext,
    routing: RoutingDecision,
    selected: SelectedAgentAssignment[],
  ): Promise<{ success: boolean; commitHash?: string; output?: string; worktreePath?: string }> {
    const headCommit = ctx.baseCommit ?? (await ctx.gitService.getHeadCommit());
    const strategy = routing.strategy;

    if (strategy === 'pair' || selected.length === 2) {
      const lead = selected[0];
      const partner = selected[1];

      const leadAsgn: AgentAssignment = {
        id: `asgn-${task.id}-${lead.agent.id}-${lead.roleRequest.role}`,
        taskId: task.id,
        agentId: lead.agent.id,
        role: lead.roleRequest.role,
        objective: lead.roleRequest.objective || task.contract.objective,
        status: 'running',
      };
      const partnerAsgn: AgentAssignment = {
        id: `asgn-${task.id}-${partner.agent.id}-${partner.roleRequest.role}`,
        taskId: task.id,
        agentId: partner.agent.id,
        role: partner.roleRequest.role,
        objective:
          partner.roleRequest.objective || `Review and assist with ${task.contract.objective}`,
        status: 'pending',
      };

      ctx.assignmentRepo.create(leadAsgn, ctx.runId);
      ctx.assignmentRepo.create(partnerAsgn, ctx.runId);

      ctx.activityTracker?.register({
        taskId: task.id,
        assignmentId: leadAsgn.id,
        taskTitle: task.title,
        agentId: lead.agent.id,
        agentName: lead.agent.name,
        role: lead.roleRequest.role,
        status: `Pair lead starting ${lead.roleRequest.role}...`,
        startedAt: new Date(),
        lastActiveAt: new Date(),
      });

      // 1. Lead creates worktree and implements
      const wt = await ctx.worktreeManager.createWorktree(task.id, leadAsgn.id, headCommit);
      const leadRes = await lead.agent.execute(leadAsgn, {
        worktreePath: wt.path,
        task: task.contract,
        assignment: leadAsgn,
        onProgress: ctx.onProgress,
        abortSignal: ctx.abortSignal,
      });

      if (!leadRes.success) {
        ctx.assignmentRepo.updateStatus(leadAsgn.id, 'failed');
        ctx.assignmentRepo.updateStatus(partnerAsgn.id, 'cancelled');
        return { success: false, output: leadRes.output, worktreePath: wt.path };
      }

      ctx.assignmentRepo.updateStatus(leadAsgn.id, 'completed');

      // 2. Partner reviews/refines in the same worktree
      ctx.assignmentRepo.updateStatus(partnerAsgn.id, 'running');
      ctx.activityTracker?.register({
        taskId: task.id,
        assignmentId: partnerAsgn.id,
        taskTitle: task.title,
        agentId: partner.agent.id,
        agentName: partner.agent.name,
        role: partner.roleRequest.role,
        status: `Pair partner reviewing (${partner.roleRequest.role})...`,
        startedAt: new Date(),
        lastActiveAt: new Date(),
      });

      const partnerRes = await partner.agent.execute(partnerAsgn, {
        worktreePath: wt.path,
        task: {
          ...task.contract,
          objective: partner.roleRequest.objective,
        },
        assignment: partnerAsgn,
        onProgress: ctx.onProgress,
        abortSignal: ctx.abortSignal,
      });

      if (!partnerRes.success) {
        ctx.assignmentRepo.updateStatus(partnerAsgn.id, 'failed');
        return { success: false, output: partnerRes.output, worktreePath: wt.path };
      }

      ctx.assignmentRepo.updateStatus(partnerAsgn.id, 'completed');

      const combinedOutput = [
        `[Lead - ${lead.agent.name} (${lead.roleRequest.role})]:\n${leadRes.output ?? 'Implemented'}`,
        `[Partner - ${partner.agent.name} (${partner.roleRequest.role})]:\n${partnerRes.output ?? 'Reviewed and verified'}`,
      ].join('\n\n');

      return {
        success: true,
        commitHash: partnerRes.commitHash ?? leadRes.commitHash,
        worktreePath: wt.path,
        output: combinedOutput,
      };
    } else {
      // Parallel / Multi-Worker Team (> 2 agents)
      const implementer =
        selected.find((s) => s.roleRequest.role === 'implementer') ?? selected[0];
      const investigators = selected.filter((s) => s !== implementer);

      const asgnGraph = AssignmentGraph.buildParallelInvestigationGraph(
        task.id,
        investigators.map((inv) => ({
          id: inv.agent.id,
          role: inv.roleRequest.role,
          objective: inv.roleRequest.objective,
        })),
        {
          id: implementer.agent.id,
          role: implementer.roleRequest.role,
          objective: implementer.roleRequest.objective || task.contract.objective,
        },
      );

      for (const node of asgnGraph.getAllNodes()) {
        ctx.assignmentRepo.create(node.assignment, ctx.runId);
      }

      const completed = new Set<string>();
      const outputs: Array<{ role: string; agentId: string; output: string }> = [];

      const runnable = asgnGraph.getRunnableAssignments(completed);
      await Promise.all(
        runnable.map(async (asgn) => {
          ctx.activityTracker?.register({
            taskId: task.id,
            assignmentId: asgn.id,
            taskTitle: task.title,
            agentId: asgn.agentId,
            agentName: asgn.agentId,
            role: asgn.role,
            status: `Investigating (${asgn.role})...`,
            startedAt: new Date(),
            lastActiveAt: new Date(),
          });
          const wt = await ctx.worktreeManager.createWorktree(task.id, asgn.id, headCommit);
          const ag = ctx.agentRegistry.get(asgn.agentId)!;
          const res = await ag.execute(asgn, {
            worktreePath: wt.path,
            task: task.contract,
            assignment: asgn,
            onProgress: ctx.onProgress,
            abortSignal: ctx.abortSignal,
          });
          ctx.assignmentRepo.updateStatus(asgn.id, res.success ? 'completed' : 'failed');
          outputs.push({ role: asgn.role, agentId: asgn.agentId, output: res.output ?? 'Done' });
          completed.add(asgn.id);
        }),
      );

      const synthesisNodes = asgnGraph.getRunnableAssignments(completed);
      let synthesizedObjective = task.contract.objective;
      if (synthesisNodes.length > 0) {
        const synthesisNode = synthesisNodes[0];
        const synthesized = SynthesisCoordinator.synthesize({
          taskId: task.id,
          investigationOutputs: outputs,
        });
        synthesizedObjective = `${task.contract.objective}\n\nSynthesized Guidance: ${synthesized.recommendedFix}`;
        ctx.assignmentRepo.updateStatus(synthesisNode.id, 'completed');
        completed.add(synthesisNode.id);
      }

      const implNodes = asgnGraph.getRunnableAssignments(completed);
      if (implNodes.length === 0) {
        return { success: false, output: 'No implementation assignment available after synthesis' };
      }
      const implNode = implNodes[0];
      const implWt = await ctx.worktreeManager.createWorktree(task.id, implNode.id, headCommit);
      const implAgent = ctx.agentRegistry.get(implNode.agentId)!;
      const implRes = await implAgent.execute(implNode, {
        worktreePath: implWt.path,
        task: {
          ...task.contract,
          objective: synthesizedObjective,
        },
        assignment: implNode,
        onProgress: ctx.onProgress,
        abortSignal: ctx.abortSignal,
      });

      ctx.assignmentRepo.updateStatus(implNode.id, implRes.success ? 'completed' : 'failed');

      return {
        success: implRes.success,
        commitHash: implRes.commitHash,
        worktreePath: implWt.path,
        output: implRes.output,
      };
    }
  }
}
