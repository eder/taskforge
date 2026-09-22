import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TaskForgeDatabase,
  AssignmentRepository,
  ExecutionRepository,
  EventRepository,
  WorkspaceRepository,
  RunRepository,
  TaskRepository,
  GoalRepository,
} from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry, AgentAdapter, AgentQuotaTracker } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { RoutingProvider } from '@taskforge/router';
import { CommunicationBus, AssignmentGraph, SessionRegistry } from '@taskforge/collaboration';
import { getDefaultConfig } from '@taskforge/shared';
import { ConcurrencyManager, TeamMemberReservation } from '../src/concurrency-manager.js';
import { executeGovernedAssignment } from '../src/governed-assignment.js';
import { RunOrchestrator } from '../src/run-orchestrator.js';

describe('TaskForge Multi-Agent Runtime Hardening', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-hardening');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'Hardening Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'hardening@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Hardening Test\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore
      }
    }
  });

  it('1. ConcurrencyManager accounts for real team assignments and agent limits', () => {
    const config = getDefaultConfig();
    config.execution.maxParallelTasks = 3;
    config.agents = {
      agentA: { enabled: true, maxParallel: 1 },
      agentB: { enabled: true, maxParallel: 2 },
    };

    const cm = new ConcurrencyManager(config);

    expect(cm.canSchedule('agentA')).toBe(true);
    expect(cm.canSchedule('agentB')).toBe(true);

    // Acquire assignment for agentA
    cm.acquire('asgn-1', 'agentA', 'TASK-1');
    expect(cm.getAgentActiveCount('agentA')).toBe(1);
    expect(cm.canSchedule('agentA')).toBe(false); // agentA maxParallel is 1!
    expect(cm.canSchedule('agentB')).toBe(true);

    // Acquire 2 assignments for agentB in parallel (e.g. concurrent team)
    cm.acquire('asgn-2', 'agentB', 'TASK-1');
    cm.acquire('asgn-3', 'agentB', 'TASK-2');
    expect(cm.getActiveAssignmentCount()).toBe(3);
    expect(cm.canSchedule('agentB')).toBe(false); // both agentB slots used & total is 3!

    // Release asgn-1
    cm.release('asgn-1');
    expect(cm.getAgentActiveCount('agentA')).toBe(0);
    expect(cm.canSchedule('agentA')).toBe(true);
    // agentB is still at maxParallel: 2, so cannot schedule agentB
    expect(cm.canSchedule('agentB')).toBe(false);

    // Release asgn-2
    cm.release('asgn-2');
    expect(cm.canSchedule('agentB')).toBe(true);
  });

  it('2. collaboration.maxAgentsPerTask is strictly applied to team routing and selection', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const agent1 = new FakeAgent('agent-1', 'Agent 1', [{ writeFile: { path: 'a.txt', content: '1' } }]);
    const agent2 = new FakeAgent('agent-2', 'Agent 2', [{ writeFile: { path: 'b.txt', content: '2' } }]);
    const agent3 = new FakeAgent('agent-3', 'Agent 3', [{ writeFile: { path: 'c.txt', content: '3' } }]);
    const agent4 = new FakeAgent('agent-4', 'Agent 4', [{ writeFile: { path: 'd.txt', content: '4' } }]);

    registry.register(agent1);
    registry.register(agent2);
    registry.register(agent3);
    registry.register(agent4);

    // Router requesting 4 roles
    const router: RoutingProvider = {
      id: 'mock-large-team-router',
      route: async () => ({
        strategy: 'parallel',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'high',
        teamSize: 4,
        roles: [
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Impl', preferredAgent: 'agent-1' },
          { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'Rev 1', preferredAgent: 'agent-2' },
          { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'Rev 2', preferredAgent: 'agent-3' },
          { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'Rev 3', preferredAgent: 'agent-4' },
        ],
        communication: { required: true, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'Large team requested',
      }),
    };

    const config = getDefaultConfig();
    config.collaboration.maxAgentsPerTask = 2; // Strict limit: 2
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-LIMIT',
      title: 'Limit test',
      description: 'Test maxAgentsPerTask limit',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-LIMIT',
        objective: 'Test limit',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Valid acceptance criteria'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Test limit', { preplannedGraph: graph });
    expect(result.status).toBe('completed');

    const asgns = new AssignmentRepository(db).listByTask('TASK-LIMIT');
    // Investigators + implementer should not exceed maxAgentsPerTask = 2
    const executedAgents = new Set(asgns.filter((a) => a.status === 'completed').map((a) => a.agentId));
    expect(executedAgents.size).toBeLessThanOrEqual(2);

    const eventRepo = new EventRepository(db);
    const events = eventRepo.listByTask('TASK-LIMIT');
    const cappedEvents = events.filter((e) => e.type === 'STAFFING_CAPPED');
    expect(cappedEvents.length).toBeGreaterThan(0);
    expect(cappedEvents[0].payload.originalRolesCount).toBe(4);
    expect(cappedEvents[0].payload.cappedTo).toBe(2);

    db.close();
  });

  it('3. Assignment IDs are always unique across all graph constructions', () => {
    const graph1 = AssignmentGraph.buildParallelInvestigationGraph(
      'TASK-1',
      [{ id: 'agent-a', role: 'reviewer', objective: 'Investigate' }],
      { id: 'agent-b', role: 'implementer', objective: 'Implement' },
      { id: 'agent-c', role: 'reviewer', objective: 'Review' },
    );
    const graph2 = AssignmentGraph.buildParallelInvestigationGraph(
      'TASK-1',
      [{ id: 'agent-a', role: 'reviewer', objective: 'Investigate' }],
      { id: 'agent-b', role: 'implementer', objective: 'Implement' },
      { id: 'agent-c', role: 'reviewer', objective: 'Review' },
    );

    const ids1 = graph1.getAllNodes().map((n) => n.assignment.id);
    const ids2 = graph2.getAllNodes().map((n) => n.assignment.id);

    // All IDs in graph1 are distinct
    expect(new Set(ids1).size).toBe(ids1.length);
    // All IDs between graph1 and graph2 (e.g. on retry or across tasks) are unique
    for (const id of ids1) {
      expect(ids2).not.toContain(id);
    }
  });

  it('4. executeGovernedAssignment leaves persistence consistent when an adapter throws an exception', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);
    const goalRepo = new GoalRepository(db);
    const runRepo = new RunRepository(db);
    const taskRepo = new TaskRepository(db);

    goalRepo.create({ id: 'goal-1', description: 'Goal', repository: testRepoRoot });
    runRepo.create('run-err-1', 'goal-1');
    taskRepo.create({
      id: 'TASK-ERR',
      runId: 'run-err-1',
      title: 'Crashing task',
      description: 'Desc',
      type: 'implementation',
      status: 'running',
    });

    const crashingAgent = {
      id: 'crashing-agent',
      name: 'Crashing Agent',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: [] }),
      execute: async (): Promise<never> => {
        throw new Error('Adapter crashed unexpectedly with segmentation fault');
      },
    };

    const task: Task = {
      id: 'TASK-ERR',
      title: 'Crashing task',
      description: 'Task that triggers adapter exception',
      type: 'implementation',
      status: 'running',
      dependencies: [],
      contract: {
        taskId: 'TASK-ERR',
        objective: 'Crash',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Passes'],
      },
    };

    const assignment = {
      id: 'asgn-crash-1',
      taskId: 'TASK-ERR',
      agentId: 'crashing-agent',
      role: 'implementer' as const,
      objective: 'Crash',
      status: 'running' as const,
    };
    assignmentRepo.create(assignment, 'run-err-1');

    const config = getDefaultConfig();
    const headCommit = await gitService.getHeadCommit();

    const result = await executeGovernedAssignment({
      runId: 'run-err-1',
      baseCommit: headCommit,
      repoRoot: testRepoRoot,
      config,
      task,
      assignment,
      agent: crashingAgent as any,
      worktreeManager,
      workspaceRepo,
      assignmentRepo,
      executionRepo,
      eventRepo,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('segmentation fault');

    // Verify persistence consistency:
    const updatedAsgn = assignmentRepo.get('asgn-crash-1');
    expect(updatedAsgn?.status).toBe('failed');

    const execs = executionRepo.listByTask('TASK-ERR');
    expect(execs.length).toBe(1);
    expect(execs[0].status).toBe('failed');
    expect(execs[0].exitCode).toBe(1);
    expect(execs[0].errorMessage).toContain('segmentation fault');

    db.close();
  });

  it('5. Team worktrees and branches are deterministically cleaned up', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const comp1 = new FakeAgent('comp-1', 'Candidate 1', [
      { writeFile: { path: 'comp1.ts', content: 'export const c1 = 1;' }, gitCommitMessage: 'comp1' },
    ]);
    const comp2 = new FakeAgent('comp-2', 'Candidate 2', [
      { writeFile: { path: 'comp2.ts', content: 'export const c2 = 2;' }, gitCommitMessage: 'comp2' },
    ]);

    registry.register(comp1);
    registry.register(comp2);

    const compRouter: RoutingProvider = {
      id: 'mock-comp-router',
      route: async () => ({
        strategy: 'competitive',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 2,
        roles: [
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Solve', preferredAgent: 'comp-1' },
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Solve', preferredAgent: 'comp-2' },
        ],
        communication: { required: true, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'Competitive solution',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: compRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-COMP-CLEAN',
      title: 'Comp cleanup',
      description: 'Test cleanup of competitive candidates',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-COMP-CLEAN',
        objective: 'Compete and clean',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Valid acceptance criteria'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Comp cleanup', { preplannedGraph: graph });
    expect(result.status).toBe('completed');

    // Check git worktree list: only the main repo root should remain!
    const activeWorktrees = await gitService['exec'](['worktree', 'list', '--porcelain'], testRepoRoot);
    const worktreeLines = activeWorktrees.split('\n').filter((l: string) => l.startsWith('worktree '));
    expect(worktreeLines.length).toBe(1); // Only testRepoRoot!

    // Check git branches: all taskforge/ branches should have been pruned/deleted
    const branches = await gitService.listLocalBranches(testRepoRoot);
    const taskBranches = branches.filter((b) => b.startsWith('taskforge/TASK-COMP-CLEAN'));
    expect(taskBranches.length).toBe(0);

    db.close();
  });

  it('6. Review strategy runs reviewers in independent read-only detached worktrees', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    let reviewerWorktreePath = '';
    let reviewerDetachedBranch = '';

    const implementer = new FakeAgent('impl-agent', 'Implementer Agent', [
      { writeFile: { path: 'feature.ts', content: 'export const impl = true;\n' }, gitCommitMessage: 'feat: impl' },
    ]);

    const reviewer: AgentAdapter = {
      id: 'rev-agent',
      name: 'Reviewer Agent',
      detect: async () => true,
      capabilities: async () => ({
        canRead: true,
        canWrite: false,
        canExecute: true,
        languages: [],
        tools: [],
      }),
      execute: async (assignment, context) => {
        reviewerWorktreePath = context.worktreePath;
        const status = await gitService.getStatus(context.worktreePath);
        reviewerDetachedBranch = status.currentBranch;
        return { success: true, message: 'Code looks great', durationMs: 50 };
      },
    };

    registry.register(implementer);
    registry.register(reviewer);

    const reviewRouter: RoutingProvider = {
      id: 'mock-review-router',
      route: async () => ({
        strategy: 'review',
        complexity: 'medium',
        risk: 'high',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Implement', preferredAgent: 'impl-agent' },
          { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'Review', preferredAgent: 'rev-agent' },
        ],
        communication: { required: true, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'Review required',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: reviewRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-REV-DETACH',
      title: 'Review test',
      description: 'Test review detached worktree',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-REV-DETACH',
        objective: 'Implement with review',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Valid acceptance criteria'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Review test', { preplannedGraph: graph });
    expect(result.status).toBe('completed');

    // Reviewer executed in a detached HEAD worktree, not on the implementer's branch!
    expect(reviewerDetachedBranch).toBe('HEAD');
    // And reviewer worktree was removed after review
    expect(fs.existsSync(reviewerWorktreePath)).toBe(false);

    db.close();
  });

  it('7. CommunicationBus is connected to real execution and records messages in database', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const leadAgent = new FakeAgent('lead-agent', 'Lead Agent', [
      { writeFile: { path: 'lead.ts', content: 'lead' }, gitCommitMessage: 'feat: lead' },
    ]);
    const partnerAgent = new FakeAgent('partner-agent', 'Partner Agent', [
      { writeFile: { path: 'partner.ts', content: 'partner' }, gitCommitMessage: 'feat: partner' },
    ]);

    registry.register(leadAgent);
    registry.register(partnerAgent);

    const pairRouter: RoutingProvider = {
      id: 'mock-bus-router',
      route: async () => ({
        strategy: 'pair',
        complexity: 'medium',
        risk: 'medium',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Part 1', preferredAgent: 'lead-agent' },
          { role: 'reviewer', requiredCapabilities: ['canWrite'], objective: 'Part 2', preferredAgent: 'partner-agent' },
        ],
        communication: { required: true, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'Pair handoff',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: pairRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-BUS',
      title: 'Bus test',
      description: 'Test bus message recording',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-BUS',
        objective: 'Test bus',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Valid acceptance criteria'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Bus test', { preplannedGraph: graph });
    expect(result.status).toBe('completed');

    // Check that CommunicationBus recorded handoff message in the database!
    const messages = db.prepare('SELECT * FROM agent_messages WHERE task_id = ?').all('TASK-BUS') as any[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].type).toBe('handoff');
    expect(messages[0].body).toContain('Handoff from Lead Agent');

    db.close();
  });

  it('8. SessionRegistry routes messages using actual runtime session IDs', async () => {
    const registry = new SessionRegistry();
    const db = new TaskForgeDatabase(':memory:');
    const goalRepo = new GoalRepository(db);
    const runRepo = new RunRepository(db);
    goalRepo.create({ id: 'goal-msg', description: 'Goal', repository: testRepoRoot });
    runRepo.create('run-msg', 'goal-msg');
    const eventRepo = new EventRepository(db);
    const bus = new CommunicationBus(db, eventRepo, {}, registry);

    const receivedSessions: string[] = [];
    const receivedMessages: any[] = [];

    const mockAdapter: AgentAdapter = {
      id: 'mock-agent',
      name: 'Mock Agent',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: [] }),
      execute: async () => ({ success: true, message: 'ok', durationMs: 10 }),
      send: async (sessionId: string, message: any) => {
        receivedSessions.push(sessionId);
        receivedMessages.push(message);
      },
    };

    registry.register({
      assignmentId: 'asgn-worker-1',
      sessionId: 'sess-runtime-uuid-999',
      agentId: 'mock-agent',
      taskId: 'TASK-MSG-1',
      adapter: mockAdapter,
    });

    // Send a message targeted at asgn-worker-1
    await bus.sendMessage({
      runId: 'run-msg',
      taskId: 'TASK-MSG-1',
      fromAssignmentId: 'asgn-lead-1',
      toAssignmentId: 'asgn-worker-1',
      type: 'handoff',
      body: 'Here is the handoff payload',
    });

    // Verification: adapter.send received sessionId ('sess-runtime-uuid-999') and NOT assignmentId ('asgn-worker-1')
    expect(receivedSessions.length).toBe(1);
    expect(receivedSessions[0]).toBe('sess-runtime-uuid-999');
    expect(receivedMessages[0].body).toBe('Here is the handoff payload');

    // After unregistering
    registry.unregister('asgn-worker-1');
    expect(registry.getByAssignment('asgn-worker-1')).toBeUndefined();

    db.close();
  });

  it('9. Review strategy deterministically rejects implementation when reviewer returns critical findings', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const impl = new FakeAgent('impl-agent-crit', 'Implementer Agent', [
      { writeFile: { path: 'vuln.ts', content: 'eval("hack");\n' }, gitCommitMessage: 'feat: vuln' },
    ]);

    const reviewerWithCrit: AgentAdapter = {
      id: 'rev-agent-crit',
      name: 'Security Reviewer Agent',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: false, canExecute: true, languages: [], tools: [] }),
      execute: async () => {
        return {
          success: true,
          message: 'Review completed with security findings',
          durationMs: 50,
          findings: [
            {
              severity: 'critical',
              description: 'Remote code execution via eval',
              file: 'vuln.ts',
              line: 1,
            },
          ],
        };
      },
    };

    registry.register(impl);
    registry.register(reviewerWithCrit);

    const reviewRouter: RoutingProvider = {
      id: 'mock-review-crit-router',
      route: async () => ({
        strategy: 'review',
        complexity: 'medium',
        risk: 'high',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Implement', preferredAgent: 'impl-agent-crit' },
          { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'Review', preferredAgent: 'rev-agent-crit' },
        ],
        communication: { required: true, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'Security review',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: reviewRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-REV-CRIT',
      title: 'Vulnerable task',
      description: 'Task that triggers critical review finding',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-REV-CRIT',
        objective: 'Implement safely',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Passes security check'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Vulnerable task', { preplannedGraph: graph });
    expect(result.status).toBe('failed');

    const dbTask = new TaskRepository(db).get('TASK-REV-CRIT');
    expect(['failed', 'blocked']).toContain(dbTask?.status);

    db.close();
  });

  it('10. ConcurrencyManager atomically reserves and waits for team slots with abort support', async () => {
    const config = getDefaultConfig();
    config.execution.maxParallelTasks = 2;
    config.agents = {
      agentA: { enabled: true, maxParallel: 1 },
      agentB: { enabled: true, maxParallel: 1 },
    };

    const cm = new ConcurrencyManager(config);

    const teamMembers: TeamMemberReservation[] = [
      { taskId: 'TASK-T1', assignmentId: 'asgn-t1', agentId: 'agentA' },
      { taskId: 'TASK-T1', assignmentId: 'asgn-t2', agentId: 'agentB' },
    ];

    expect(cm.canScheduleTeam(teamMembers)).toBe(true);
    await cm.waitForTeamSlots(teamMembers);

    // Both slots now taken
    expect(cm.canSchedule('agentA')).toBe(false);
    expect(cm.canSchedule('agentB')).toBe(false);

    // Another team cannot schedule
    const team2: TeamMemberReservation[] = [
      { taskId: 'TASK-T2', assignmentId: 'asgn-t3', agentId: 'agentA' },
    ];
    expect(cm.canScheduleTeam(team2)).toBe(false);

    // Test waiting for slots when one slot frees up
    let scheduled = false;
    const waitPromise = cm.waitForTeamSlots(team2).then(() => {
      scheduled = true;
    });

    expect(scheduled).toBe(false);

    // Release agentA from first team
    cm.release('asgn-t1');
    await waitPromise;
    expect(scheduled).toBe(true);

    // Test abort signal rejects waitForTeamSlots
    const team3: TeamMemberReservation[] = [
      { taskId: 'TASK-T3', assignmentId: 'asgn-t4', agentId: 'agentA' },
    ];
    const abortCtrl = new AbortController();
    const abortPromise = cm.waitForTeamSlots(team3, abortCtrl.signal);
    abortCtrl.abort();
    await expect(abortPromise).rejects.toThrow('Aborted while waiting for team concurrency slots');
  });

  it('11. Cancellation marks assignment and execution cancelled and cleans up resources', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);
    const goalRepo = new GoalRepository(db);
    const runRepo = new RunRepository(db);
    const taskRepo = new TaskRepository(db);

    goalRepo.create({ id: 'goal-c1', description: 'Goal', repository: testRepoRoot });
    runRepo.create('run-c1', 'goal-c1');
    taskRepo.create({
      id: 'TASK-CANCEL',
      runId: 'run-c1',
      title: 'Cancelling task',
      description: 'Desc',
      type: 'implementation',
      status: 'running',
    });

    const abortController = new AbortController();

    const cancellingAgent: AgentAdapter = {
      id: 'cancelling-agent',
      name: 'Cancelling Agent',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: [] }),
      execute: async (_assignment, ctx) => {
        abortController.abort();
        if (ctx.abortSignal?.aborted) {
          return { success: false, message: 'Execution cancelled by user', durationMs: 10 };
        }
        return { success: true, message: 'completed', durationMs: 10 };
      },
    };

    const task: Task = {
      id: 'TASK-CANCEL',
      title: 'Cancelling task',
      description: 'Task that gets cancelled',
      type: 'implementation',
      status: 'running',
      dependencies: [],
      contract: {
        taskId: 'TASK-CANCEL',
        objective: 'Cancel',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: [],
      },
    };

    const assignment = {
      id: 'asgn-cancel-1',
      taskId: 'TASK-CANCEL',
      agentId: 'cancelling-agent',
      role: 'implementer' as const,
      objective: 'Cancel',
      status: 'running' as const,
    };
    assignmentRepo.create(assignment, 'run-c1');

    const config = getDefaultConfig();
    const headCommit = await gitService.getHeadCommit();

    const result = await executeGovernedAssignment({
      runId: 'run-c1',
      baseCommit: headCommit,
      repoRoot: testRepoRoot,
      config,
      task,
      assignment,
      agent: cancellingAgent,
      worktreeManager,
      workspaceRepo,
      assignmentRepo,
      executionRepo,
      eventRepo,
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('cancelled');

    const asgnRecord = assignmentRepo.get('asgn-cancel-1');
    expect(asgnRecord?.status).toBe('cancelled');

    const execRecords = executionRepo.listByTask('TASK-CANCEL');
    expect(execRecords[0]?.status).toBe('cancelled');

    db.close();
  });

  it('12. production invariant: project overview stays one read-only assignment despite planner/router/collaboration overreach', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    const executionCounts = new Map<string, number>();

    const makeOverviewAgent = (id: string, name: string): AgentAdapter => ({
      id,
      name,
      detect: async () => true,
      capabilities: async () => ({
        canRead: true,
        canWrite: true,
        canExecute: true,
        languages: [],
        tools: [],
      }),
      execute: async () => {
        executionCounts.set(id, (executionCounts.get(id) ?? 0) + 1);
        return {
          success: true,
          message: 'Repository overview completed',
          output:
            'This repository is a current-codebase overview produced from files in the isolated read-only workspace.',
          durationMs: 10,
          collaborationProposal: {
            reason: 'I would like another reviewer',
            requestedRoles: ['reviewer'],
          },
        };
      },
    });

    registry.register(makeOverviewAgent('claude', 'Claude Code'));
    registry.register(makeOverviewAgent('codex', 'Codex CLI'));
    registry.register(makeOverviewAgent('agy', 'Google Antigravity'));

    const overstaffingRouter: RoutingProvider = {
      id: 'overstaffing-router',
      route: async () => ({
        strategy: 'parallel',
        source: 'openai',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 3,
        roles: [
          {
            role: 'reproduction_engineer',
            requiredCapabilities: ['canRead'],
            objective: 'Inspect structure',
          },
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'Read docs' },
          {
            role: 'architecture_reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review architecture',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Deliberately bad router proposal for regression coverage',
      }),
    };

    const graph = new TaskGraph();
    for (let i = 1; i <= 4; i++) {
      const id = `TASK-0${i}`;
      graph.addTask({
        id,
        goalId: 'goal-overview',
        title: `Over-decomposed task ${i}`,
        description: 'Unnecessarily split project overview work',
        type: i === 4 ? 'review' : 'investigation',
        status: 'proposed',
        dependencies: [],
        contract: {
          taskId: id,
          objective: 'Inspect one slice of the repository',
          allowedScope: i === 1 ? ['*'] : [],
          forbiddenChanges: i === 1 ? [] : ['*'],
          acceptanceCriteria: ['Return findings'],
          completionMode: i === 4 ? 'review' : 'report',
          dependencies: [],
          metadata: {
            recommendCollaboration: true,
            collaboration: {
              requestedRoles: ['researcher', 'architecture_reviewer'],
              reason: 'Over-decomposed planner requested collaboration',
            },
          },
        },
        acceptanceCriteria: ['Return findings'],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const config = getDefaultConfig();
    config.verification.tests = true;
    config.verification.lint = true;
    config.verification.typecheck = true;

    const progressLogs: string[] = [];
    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: overstaffingRouter,
      gitService,
      worktreeManager,
    });

    const result = await orchestrator.run('O que é esse projeto?', {
      preplannedGraph: graph,
      onProgress: (message) => progressLogs.push(message),
    });

    expect(result.status).toBe('completed');
    expect(result.executionIntent.intent).toBe('READ_ONLY_ANALYSIS');
    expect(result.executionIntent.mutationAllowed).toBe(false);
    expect(result.graph.getAllTasks()).toHaveLength(1);

    const task = result.graph.getAllTasks()[0];
    expect(task.type).toBe('investigation');
    expect(task.contract.completionMode).toBe('report');
    expect(task.contract.allowedScope).toEqual([]);
    expect(task.contract.forbiddenChanges).toEqual(['*']);
    expect(task.contract.metadata?.lightweightReadOnlyInvariant).toBe(true);

    const assignments = new AssignmentRepository(db).listByRun(result.runId);
    expect(assignments).toHaveLength(1);
    expect(Array.from(executionCounts.values()).reduce((sum, count) => sum + count, 0)).toBe(1);

    const events = new EventRepository(db).listByRun(result.runId);
    expect(events.some((event) => event.type === 'PLAN_INVARIANT_ENFORCED')).toBe(true);
    expect(events.some((event) => event.type === 'COLLABORATION_APPROVED')).toBe(false);
    expect(events.some((event) => event.type === 'COLLABORATION_REJECTED')).toBe(true);

    expect(progressLogs.some((line) => line.includes('Scheduling 1 read-only task...'))).toBe(true);
    expect(progressLogs.some((line) => line.includes('across worktrees'))).toBe(false);
    expect(progressLogs.some((line) => line.includes('Running verification checks'))).toBe(false);
    expect(
      progressLogs.some((line) =>
        line.includes('Read-only report accepted; automated repository verification not applicable'),
      ),
    ).toBe(true);
    expect(progressLogs.some((line) => line.includes('Report completion validated ✓'))).toBe(true);
    expect(progressLogs.some((line) => line.includes('Verified successfully ✓'))).toBe(false);
    expect(progressLogs.some((line) => line.includes('Execution intent: READ_ONLY_ANALYSIS'))).toBe(
      true,
    );

    db.close();
  });

  it('13. Emergent collaboration validates proposal against maxAgentsPerTask limit', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const primaryAgent: AgentAdapter = {
      id: 'primary-worker',
      name: 'Primary Worker',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: [] }),
      execute: async (_asgn, execCtx) => {
        fs.writeFileSync(path.join(execCtx.worktreePath, 'feature.txt'), 'done\n', 'utf8');
        return {
          success: true,
          message: 'Initial work done, need helper',
          durationMs: 50,
          collaborationProposal: {
            reason: 'Complex algorithmic verification needed',
            requestedRoles: ['reviewer'],
          },
        };
      },
    };

    const helperAgent: AgentAdapter = {
      id: 'helper-worker',
      name: 'Helper Worker',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: [] }),
      execute: async () => {
        return {
          success: true,
          message: 'Review and verification passed',
          durationMs: 50,
        };
      },
    };

    registry.register(primaryAgent);
    registry.register(helperAgent);

    const emergentRouter: RoutingProvider = {
      id: 'emergent-primary-router',
      route: async () => ({
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite', 'canExecute'],
            objective: 'Test emergent collaboration',
            preferredAgent: 'primary-worker',
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'This test requires primary-worker to initiate the collaboration proposal.',
      }),
    };

    const config = getDefaultConfig();
    config.collaboration.maxAgentsPerTask = 2; // Allows 1 primary + 1 helper
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: emergentRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-EMERGENT',
      title: 'Emergent collaboration task',
      description: 'Task with collaboration proposal',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-EMERGENT',
        objective: 'Test emergent collaboration',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Valid criteria'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Emergent collaboration task', { preplannedGraph: graph });
    expect(result.status).toBe('completed');

    const eventRepo = new EventRepository(db);
    const events = eventRepo.listByTask('TASK-EMERGENT');
    const approved = events.filter((e) => e.type === 'COLLABORATION_APPROVED');
    expect(approved.length).toBe(1);
    expect(approved[0].payload.addedAgent).toBe('helper-worker');

    const asgns = new AssignmentRepository(db).listByTask('TASK-EMERGENT');
    expect(asgns.length).toBe(2);
    expect(asgns.every((a) => a.status === 'completed')).toBe(true);

    db.close();
  });

  it('14. Emergent collaboration is rejected when maxAgentsPerTask limit is reached', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const greedyAgent: AgentAdapter = {
      id: 'greedy-worker',
      name: 'Greedy Worker',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: [] }),
      execute: async () => {
        return {
          success: true,
          message: 'Cannot finish alone',
          durationMs: 50,
          collaborationProposal: {
            reason: 'Want extra help',
            requestedRoles: ['reviewer'],
          },
        };
      },
    };

    registry.register(greedyAgent);

    const config = getDefaultConfig();
    config.collaboration.maxAgentsPerTask = 1; // Strict limit 1 -> cannot add another!
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-GREEDY',
      title: 'Greedy task',
      description: 'Task that requests help beyond limit',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-GREEDY',
        objective: 'Test emergent limit rejection',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Valid criteria'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Greedy task', { preplannedGraph: graph });
    expect(result.status).toBe('failed');

    const eventRepo = new EventRepository(db);
    const events = eventRepo.listByTask('TASK-GREEDY');
    const rejected = events.filter((e) => e.type === 'COLLABORATION_REJECTED');
    expect(rejected.length).toBe(1);

    db.close();
  });

  it('15. skips a provider that became quota-exhausted after routing but before execution', async () => {
    AgentQuotaTracker.resetInstance();
    const tracker = AgentQuotaTracker.getInstance();

    const db = new TaskForgeDatabase(':memory:');
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);
    const workspaceRepo = new WorkspaceRepository(db);
    const goalRepo = new GoalRepository(db);
    const runRepo = new RunRepository(db);
    const taskRepo = new TaskRepository(db);

    goalRepo.create({ id: 'goal-quota-recheck', description: 'Goal', repository: testRepoRoot });
    runRepo.create('run-quota-recheck', 'goal-quota-recheck');
    taskRepo.create({
      id: 'TASK-QUOTA-RECHECK',
      runId: 'run-quota-recheck',
      title: 'Read repository',
      description: 'Read repository',
      type: 'investigation',
      status: 'running',
    });

    let executeCalls = 0;
    const staleSelectedAgent: AgentAdapter = {
      id: 'agy',
      name: 'Google Antigravity',
      detect: async () => true,
      capabilities: async () => ({
        canRead: true,
        canWrite: true,
        canExecute: true,
        languages: [],
        tools: [],
      }),
      execute: async () => {
        executeCalls++;
        return { success: true, message: 'should not run', durationMs: 1 };
      },
    };

    const task: Task = {
      id: 'TASK-QUOTA-RECHECK',
      title: 'Read repository',
      description: 'Read repository',
      type: 'investigation',
      status: 'running',
      dependencies: [],
      contract: {
        taskId: 'TASK-QUOTA-RECHECK',
        objective: 'Read repository',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Report produced'],
        completionMode: 'report',
      },
    };

    const assignment = {
      id: 'asgn-quota-recheck',
      taskId: task.id,
      agentId: staleSelectedAgent.id,
      role: 'researcher' as const,
      objective: task.contract.objective,
      status: 'running' as const,
    };
    assignmentRepo.create(assignment, 'run-quota-recheck');

    // Simulate quota being learned after routing selected Antigravity.
    tracker.setManualStatus('agy', 'quota_exhausted', 'resets tomorrow', 60);

    const result = await executeGovernedAssignment({
      runId: 'run-quota-recheck',
      baseCommit: await gitService.getHeadCommit(),
      repoRoot: testRepoRoot,
      config: getDefaultConfig(),
      task,
      assignment,
      agent: staleSelectedAgent,
      worktreeManager,
      workspaceRepo,
      assignmentRepo,
      executionRepo,
      eventRepo,
    });

    expect(result.success).toBe(false);
    expect(result.completionReason).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(result.message).toContain('Provider unavailable before execution');
    expect(executeCalls).toBe(0);
    expect(assignmentRepo.get(assignment.id)?.status).toBe('failed');

    const events = eventRepo.listByTask(task.id);
    expect(events.some((event) => event.type === 'ASSIGNMENT_SKIPPED_UNAVAILABLE')).toBe(true);

    db.close();
    AgentQuotaTracker.resetInstance();
  });

  it('16. Structured JSON output from reviewer model is automatically parsed into findings with file:line references', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const impl = new FakeAgent('impl-agent-json', 'Implementer Agent', [
      { writeFile: { path: 'auth.ts', content: 'export const token = "abc";\n' }, gitCommitMessage: 'feat: token' },
    ]);

    // Reviewer returns markdown containing structured JSON findings block
    const reviewerWithJsonOutput: AgentAdapter = {
      id: 'rev-agent-json',
      name: 'Structured Reviewer Agent',
      detect: async () => true,
      capabilities: async () => ({ canRead: true, canWrite: false, canExecute: true, languages: [], tools: [] }),
      execute: async () => {
        return {
          success: true,
          message: 'Review completed',
          durationMs: 50,
          output: `Here is the security review report:

\`\`\`json
{
  "findings": [
    {
      "severity": "critical",
      "file": "src/auth/token.ts",
      "line": 88,
      "description": "Hardcoded token secret enables token forgery"
    }
  ]
}
\`\`\`
`,
        };
      },
    };

    registry.register(impl);
    registry.register(reviewerWithJsonOutput);

    const reviewRouter: RoutingProvider = {
      id: 'mock-review-json-router',
      route: async () => ({
        strategy: 'review',
        complexity: 'medium',
        risk: 'high',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Implement', preferredAgent: 'impl-agent-json' },
          { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'Review', preferredAgent: 'rev-agent-json' },
        ],
        communication: { required: true, initialAlignment: false, synthesisBeforeImplementation: false },
        reason: 'Security review with JSON output',
      }),
    };

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const progressLogs: string[] = [];

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      database: db,
      agentRegistry: registry,
      router: reviewRouter,
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-REV-JSON',
      title: 'Token task',
      description: 'Task reviewed with structured JSON findings',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-REV-JSON',
        objective: 'Implement token',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Valid criteria'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Token task', {
      preplannedGraph: graph,
      onProgress: (m) => progressLogs.push(m),
    });

    expect(result.status).toBe('failed');

    // Verify file and line reference was logged in progress
    const criticalLog = progressLogs.find((l) => l.includes('src/auth/token.ts:88'));
    expect(criticalLog).toBeDefined();
    expect(criticalLog).toContain('Hardcoded token secret enables token forgery');

    db.close();
  });
});
