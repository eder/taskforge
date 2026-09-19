import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
  AuditService,
} from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { AgentRegistry, FakeAgent } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService } from '@taskforge/integration';
import { DeterministicScheduler } from '@taskforge/scheduler';
import { HeuristicPlanner } from '@taskforge/planner';
import { NegotiationManager, PreflightEvaluator } from '@taskforge/negotiation';
import { StaticRoutingProvider, OpenAIRoutingProvider, AgentSelector } from '@taskforge/router';
import {
  CommunicationBus,
  AssignmentGraph,
  SynthesisCoordinator,
  EscalationHandler,
} from '@taskforge/collaboration';
import { InteractiveShell } from '@taskforge/conversation';
import { TaskForgeConfig, TaskPreflightResult } from '@taskforge/shared';

describe('TaskForge Phases 6-13 End-to-End Orchestration', () => {
  let testDir: string;
  let repoDir: string;
  let dbPath: string;
  let gitService: GitService;
  let db: TaskForgeDatabase;
  let runRepo: RunRepository;
  let goalRepo: GoalRepository;
  let taskRepo: TaskRepository;
  let assignmentRepo: AssignmentRepository;
  let executionRepo: ExecutionRepository;
  let eventRepo: EventRepository;
  let verificationRepo: VerificationRepository;
  let workspaceRepo: WorkspaceRepository;
  let auditService: AuditService;
  let worktreeManager: WorktreeManager;
  let verificationRunner: VerificationRunner;
  let integrationService: IntegrationService;
  let headCommit: string;

  const testConfig: TaskForgeConfig = {
    version: 1,
    project: { name: 'test-e2e-phases6-13' },
    execution: {
      runsDir: '.taskforge/runs',
      worktreesDir: '.taskforge/worktrees',
      databasePath: ':memory:',
      maxConcurrentTasks: 4,
      maxAgentsPerTask: 3,
      perAgentWorktrees: true,
      defaultTimeoutMs: 30000,
    },
    agents: {
      concurrency: {
        'fake-investigator-1': 1,
        'fake-investigator-2': 1,
        'fake-investigator-3': 1,
        'fake-implementer': 1,
        'fake-escalator': 1,
      },
    },
    verification: {
      tests: false,
      lint: false,
      typecheck: false,
      maxReworkCycles: 2,
    },
    integration: {
      strategy: 'cherry-pick',
      requirePassingVerification: false,
      autoPush: false,
    },
    router: {
      provider: 'static',
      model: 'gpt-5.6-luna',
      timeoutMs: 15000,
    },
    planner: {
      agent: 'fake-implementer',
      timeoutMs: 30000,
    },
    collaboration: {
      maxMessagesPerTask: 10,
      maxRounds: 3,
      synthesisBeforeImplementation: true,
    },
  };

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-e2e-6-13-'));
    repoDir = path.join(testDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });

    gitService = new GitService(repoDir);
    await gitService.execGit(['init', '-b', 'main']);
    await gitService.execGit(['config', 'user.name', 'TaskForge Tester']);
    await gitService.execGit(['config', 'user.email', 'tester@taskforge.dev']);

    fs.writeFileSync(
      path.join(repoDir, 'README.md'),
      '# TaskForge E2E Repo for Phases 6-13\n',
      'utf8',
    );
    await gitService.execGit(['add', '.']);
    await gitService.execGit(['commit', '-m', 'chore: initial commit']);
    headCommit = await gitService.getHeadCommit();

    dbPath = path.join(testDir, 'test.db');
    db = new TaskForgeDatabase(dbPath);

    runRepo = new RunRepository(db);
    goalRepo = new GoalRepository(db);
    taskRepo = new TaskRepository(db);
    assignmentRepo = new AssignmentRepository(db);
    executionRepo = new ExecutionRepository(db);
    eventRepo = new EventRepository(db);
    verificationRepo = new VerificationRepository(db);
    workspaceRepo = new WorkspaceRepository(db);
    auditService = new AuditService(runRepo, goalRepo, taskRepo, eventRepo);

    worktreeManager = new WorktreeManager(repoDir, path.join(repoDir, '.taskforge/worktrees'));
    verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
    integrationService = new IntegrationService(
      repoDir,
      gitService,
      worktreeManager,
      verificationRunner,
      eventRepo,
    );
  });

  afterEach(async () => {
    try {
      db.close();
      await gitService.execGit(['worktree', 'prune']).catch(() => {});
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore cleanup errors in test teardown
    }
  });

  it('Phase 6 & 7: Interactive shell REPL and Operator Agent intent handling', async () => {
    const shell = new InteractiveShell({
      repoRoot: repoDir,
      config: testConfig,
    });

    const banner = await shell.renderBanner();
    expect(banner).toContain('TaskForge');
    expect(banner).toContain('main');
    expect(banner).toContain('clean');

    // Natural language inspection & commands
    const agentsResp = await shell.handleInput('quais agentes estão disponíveis?');
    expect(agentsResp).toContain('Agentes disponíveis:');

    const pauseResp = await shell.handleInput('pausar execução do run');
    expect(pauseResp).toContain('pausada');

    const resumeResp = await shell.handleInput('retomar a execução');
    expect(resumeResp).toContain('retomada');

    const constraintResp = await shell.handleInput('não altere o arquivo database.sqlite');
    expect(constraintResp).toContain('Restrição');

    // Submitting goal via natural language invokes Planner, Negotiator, Router, and AgentSelector
    const planResp = await shell.handleInput('investigar e resolver memory leak crítico');
    expect(planResp).toContain('Estratégia recomendada:');
    expect(planResp).toContain('tarefas estruturadas');
  });

  it('Phase 8 & 9: Planner with Preflight Negotiation and Challenge Resolution', async () => {
    const planner = new HeuristicPlanner();
    const goal = {
      id: 'goal-6-13-1',
      description: 'Implement secure payment webhook with verification and tests',
      repository: repoDir,
      constraints: ['No unencrypted payload logging'],
      acceptanceCriteria: ['Webhook verified and tests pass'],
      createdAt: new Date(),
    };

    const initialGraph = await planner.plan(goal);
    expect(initialGraph.getAllTasks().length).toBeGreaterThan(0);

    // Custom preflight evaluator that challenges the second task with missing dependency
    class ChallengingPreflight implements PreflightEvaluator {
      async evaluate(task: Task): Promise<TaskPreflightResult> {
        if (task.id === 'TASK-2' || task.id === 'TASK-02') {
          return {
            decision: 'challenge',
            understanding: 'Cannot build webhook handler without shared crypto library',
            concerns: ['Do not use deprecated MD5/SHA1'],
            missingContext: [],
            suggestedDependencies: ['TASK-01'],
          };
        }
        return {
          decision: 'accept',
          understanding: 'Ready to proceed',
          concerns: [],
          missingContext: [],
          suggestedDependencies: [],
        };
      }
    }

    const negotiator = new NegotiationManager(new ChallengingPreflight(), eventRepo, db);
    const runId = 'run-preflight-test';
    runRepo.create(runId, goal.id);

    const negotiatedGraph = await negotiator.negotiateGraph(initialGraph, runId);
    const task2 = negotiatedGraph.getTask('TASK-02') ?? negotiatedGraph.getTask('TASK-2');
    expect(task2).toBeDefined();
    expect(task2?.dependencies).toContain('TASK-01');
    expect(task2?.contract.forbiddenChanges).toContain('Do not use deprecated MD5/SHA1');

    // Audit events stored in SQLite
    const events = eventRepo.listByRun(runId);
    expect(events.some((e) => e.type === 'TASK_CHALLENGED')).toBe(true);
    expect(events.some((e) => e.type === 'TASK_ACCEPTED')).toBe(true);

    const dbRows = db.prepare('SELECT * FROM preflight_results WHERE run_id = ?').all(runId);
    expect(dbRows.length).toBeGreaterThanOrEqual(2);
  });

  it('Phase 10 & 11: Router structured decisions and AgentSelector mapping', async () => {
    const mockTask: Task = {
      id: 'TASK-INVESTIGATION',
      goalId: 'goal-mock',
      title: 'Analyze deadlocks in parallel database workers',
      description: 'Find root cause of concurrency contention',
      type: 'investigation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Determine concurrency bottleneck',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Root cause report created'],
        dependencies: [],
      },
      acceptanceCriteria: ['Root cause documented'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const staticRouter = new StaticRoutingProvider();
    const staticDecision = await staticRouter.route({
      task: mockTask,
      availableAgents: ['fake-investigator-1'],
    });
    expect(staticDecision.strategy).toBe('parallel');

    const openAIRouter = new OpenAIRoutingProvider(undefined); // tests fallback

    const decision = await openAIRouter.route({
      task: mockTask,
      availableAgents: ['fake-investigator-1', 'fake-investigator-2', 'fake-implementer'],
    });

    expect(decision.strategy).toBe('parallel');
    expect(decision.complexity).toBe('high');
    expect(decision.roles.length).toBeGreaterThan(1);
    expect(decision.communication.synthesisBeforeImplementation).toBe(true);

    // Roles are neutral abstract roles
    expect(decision.roles.map((r) => r.role)).toContain('researcher');

    // AgentSelector
    const registry = new AgentRegistry();
    registry.register(new FakeAgent('fake-investigator-1', 'Investigator 1'));
    registry.register(new FakeAgent('fake-implementer', 'Implementer 1'));

    const selector = new AgentSelector(registry);
    const selected = await selector.selectAgents(decision.roles);
    expect(selected.length).toBe(decision.roles.length);
    for (const match of selected) {
      expect(match.agent).toBeDefined();
    }
  });

  it('Phase 12 & 13: Collaborative Execution with 3 FakeAgents in parallel investigation, synthesis node, and integration', async () => {
    const runId = 'run-collab-3-agents';
    const goalId = 'goal-collab';
    goalRepo.create({
      id: goalId,
      description: 'Collaborative root cause investigation and fix',
      repository: repoDir,
    });
    runRepo.create(runId, goalId);

    const bus = new CommunicationBus(db, eventRepo, {
      maxMessagesPerRound: 6,
      maxRounds: 3,
    });

    // Create 3 parallel investigator fake agents and 1 implementer
    const inv1 = new FakeAgent('fake-investigator-1', 'Log Investigator', [
      {
        writeFile: {
          path: 'findings/logs.txt',
          content: 'Logs confirm deadlock on transaction lock A\n',
        },
        gitCommitMessage: 'feat: log investigation findings',
      },
    ]);

    const inv2 = new FakeAgent('fake-investigator-2', 'Code Profiler', [
      {
        writeFile: {
          path: 'findings/profile.txt',
          content: 'Contention on mutex in scheduler.ts:140\n',
        },
        gitCommitMessage: 'feat: profiling findings',
      },
    ]);

    const inv3 = new FakeAgent('fake-investigator-3', 'Repro Engineer', [
      {
        writeFile: {
          path: 'findings/repro.txt',
          content: 'Reproduction script passes 100 concurrent workers\n',
        },
        gitCommitMessage: 'feat: reproduction script',
      },
    ]);

    const impl = new FakeAgent('fake-implementer', 'Fix Implementer', [
      {
        writeFile: {
          path: 'src/fix.txt',
          content: 'Applied synthesized lock ordering to prevent deadlock\n',
        },
        gitCommitMessage: 'fix: apply synthesized deadlock resolution',
      },
    ]);

    const agentRegistry = new AgentRegistry();
    agentRegistry.register(inv1);
    agentRegistry.register(inv2);
    agentRegistry.register(inv3);
    agentRegistry.register(impl);

    // Register with communication bus
    bus.registerAgent('asgn-inv-1', inv1);
    bus.registerAgent('asgn-inv-2', inv2);
    bus.registerAgent('asgn-inv-3', inv3);

    // Agents exchange bounded structured messages
    await bus.sendMessage({
      runId,
      taskId: 'TASK-COLLAB',
      fromAssignmentId: 'asgn-inv-1',
      toAssignmentId: 'asgn-inv-2',
      type: 'query',
      body: 'Did you see the lock collision in scheduler.ts?',
    });

    await bus.sendMessage({
      runId,
      taskId: 'TASK-COLLAB',
      fromAssignmentId: 'asgn-inv-2',
      toAssignmentId: 'asgn-inv-1',
      type: 'finding',
      body: 'Confirmed: mutex contention happens at worker acquire step.',
    });

    await bus.sendMessage({
      runId,
      taskId: 'TASK-COLLAB',
      fromAssignmentId: 'asgn-inv-3',
      toAssignmentId: 'asgn-inv-1',
      type: 'proposal',
      body: 'Synthesize lock ordering before implementing fix.',
    });

    // Verify messages stored in DB
    const msgs = db.prepare('SELECT * FROM agent_messages WHERE run_id = ?').all(runId);
    expect(msgs.length).toBe(3);

    // Build AssignmentGraph for this collaborative task
    const asgnGraph = AssignmentGraph.buildParallelInvestigationGraph(
      'TASK-COLLAB',
      [
        { id: inv1.id, role: 'researcher', objective: 'Analyze logs' },
        { id: inv2.id, role: 'researcher', objective: 'Profile code' },
        { id: inv3.id, role: 'reproduction_engineer', objective: 'Reproduce deadlock' },
      ],
      { id: impl.id, role: 'implementer', objective: 'Apply synthesized fix' },
    );

    // Execute collaborative task via collaborative executor
    const collaborativeExecutors = new Map<
      string,
      (task: Task, ctx: unknown) => Promise<{ success: boolean; commitHash?: string }>
    >();

    collaborativeExecutors.set('TASK-COLLAB', async (_task, _ctx) => {
      // 1. Run all 3 investigators in parallel
      const completedAsgns = new Set<string>();
      const initialRunnable = asgnGraph.getRunnableAssignments(completedAsgns);
      expect(initialRunnable.length).toBe(3);

      const outputs: Array<{ role: string; agentId: string; output: string }> = [];

      await Promise.all(
        initialRunnable.map(async (asgn) => {
          const wt = await worktreeManager.createWorktree('TASK-COLLAB', asgn.id, headCommit);
          const ag = agentRegistry.get(asgn.agentId)!;
          const res = await ag.execute(asgn, {
            worktreePath: wt.path,
            task: _task.contract,
            assignment: asgn,
          });
          expect(res.success).toBe(true);
          outputs.push({ role: asgn.role, agentId: asgn.agentId, output: res.output ?? 'Done' });
          completedAsgns.add(asgn.id);
        }),
      );

      // 2. Run synthesis node before implementation
      const synthesisNodes = asgnGraph.getRunnableAssignments(completedAsgns);
      expect(synthesisNodes.length).toBe(1);
      const synthesisNode = synthesisNodes[0];

      const synthesized = SynthesisCoordinator.synthesize({
        taskId: 'TASK-COLLAB',
        investigationOutputs: outputs,
      });
      expect(synthesized.rootCause).toContain('Synthesized root cause from 3 workers');
      completedAsgns.add(synthesisNode.id);

      // 3. Run implementer in its worktree using synthesized fix
      const implNodes = asgnGraph.getRunnableAssignments(completedAsgns);
      expect(implNodes.length).toBe(1);
      const implNode = implNodes[0];

      const implWt = await worktreeManager.createWorktree('TASK-COLLAB', implNode.id, headCommit);
      const implAgent = agentRegistry.get(implNode.agentId)!;
      const implRes = await implAgent.execute(implNode, {
        worktreePath: implWt.path,
        task: {
          ..._task.contract,
          objective: synthesized.recommendedFix,
        },
        assignment: implNode,
      });
      expect(implRes.success).toBe(true);

      return {
        success: true,
        commitHash: implRes.commitHash,
      };
    });

    const collabTask: Task = {
      id: 'TASK-COLLAB',
      goalId,
      title: 'Parallel Investigation and Synthesis Fix',
      description: 'Coordinate 3 investigators and 1 implementer',
      type: 'investigation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Resolve deadlock with collaborative investigation',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Fix applied based on synthesis'],
        dependencies: [],
      },
      acceptanceCriteria: ['Complete'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    taskRepo.create({
      id: collabTask.id,
      runId,
      goalId,
      title: collabTask.title,
      description: collabTask.description,
      type: collabTask.type,
      status: collabTask.status,
      contract: collabTask.contract,
    });

    const taskGraph = new TaskGraph([collabTask]);

    const scheduler = new DeterministicScheduler({
      runId,
      baseCommit: headCommit,
      repoRoot: repoDir,
      config: testConfig,
      graph: taskGraph,
      agentRegistry,
      worktreeManager,
      gitService,
      verificationRunner,
      integrationService,
      runRepo,
      taskRepo,
      assignmentRepo,
      executionRepo,
      eventRepo,
      workspaceRepo,
      collaborativeExecutors,
    });

    const result = await scheduler.run();
    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(1);
    expect(result.integrationBranch).toBeDefined();

    // Verify Git integration branch has the fix
    const gitLog = await gitService.execGit(['log', '--oneline', result.integrationBranch!]);
    expect(gitLog).toContain('fix: apply synthesized deadlock resolution');

    // Verify full audit trail reconstruction in SQLite
    const audit = auditService.reconstructRun(runId);
    expect(audit.run.status).toBe('completed');
    expect(audit.tasks[0].status).toBe('integrated');
  });

  it('Phase 13: Emergent Collaboration Escalation (COLLABORATION_ESCALATED)', async () => {
    const runId = 'run-escalation-test';
    const goalId = 'goal-escalation';
    goalRepo.create({
      id: goalId,
      description: 'Task that triggers emergent collaboration',
      repository: repoDir,
    });
    runRepo.create(runId, goalId);

    // Agent that discovers scope is too large and escalates
    const escalatingAgent = new FakeAgent('fake-escalator', 'Escalating Worker', [
      {
        shouldFail: true,
        collaborationProposal: {
          reason: 'Underlying codebase requires cross-cutting auth & session refactoring',
          requestedRoles: ['researcher', 'architecture_reviewer'],
          urgency: 'high',
          expectedBenefit: 'Prevent security vulnerabilities in production',
        },
      },
    ]);

    const agentRegistry = new AgentRegistry();
    agentRegistry.register(escalatingAgent);

    const escalationHandler = new EscalationHandler(eventRepo);

    const task: Task = {
      id: 'TASK-ESCALATE',
      goalId,
      title: 'Simple feature that turns out to require architecture overhaul',
      description: 'Will trigger collaboration escalation',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      contract: {
        objective: 'Implement feature safely',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Done'],
        dependencies: [],
      },
      acceptanceCriteria: ['Done'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    taskRepo.create({
      id: task.id,
      runId,
      goalId,
      title: task.title,
      description: task.description,
      type: task.type,
      status: task.status,
      contract: task.contract,
    });

    const graph = new TaskGraph([task]);

    const scheduler = new DeterministicScheduler({
      runId,
      baseCommit: headCommit,
      repoRoot: repoDir,
      config: testConfig,
      graph,
      agentRegistry,
      worktreeManager,
      gitService,
      verificationRunner,
      integrationService,
      runRepo,
      taskRepo,
      assignmentRepo,
      executionRepo,
      eventRepo,
      workspaceRepo,
      preferredAgentMapping: { [task.id]: 'fake-escalator' },
      escalationHandler,
    });

    await scheduler.run();

    // Verify COLLABORATION_ESCALATED event was audited
    const events = eventRepo.listByRun(runId);
    const escalationEvent = events.find((e) => e.type === 'COLLABORATION_ESCALATED');
    expect(escalationEvent).toBeDefined();
    expect(escalationEvent?.payload.initiator).toBe('fake-escalator');
    expect(escalationEvent?.payload.requestedRoles).toEqual([
      'researcher',
      'architecture_reviewer',
    ]);
    expect(escalationEvent?.payload.urgency).toBe('high');
  });
});
