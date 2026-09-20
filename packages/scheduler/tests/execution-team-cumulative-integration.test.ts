import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { RoutingProvider, RoutingDecision } from '@taskforge/router';
import { RunOrchestrator } from '../src/run-orchestrator.js';
import { getDefaultConfig } from '@taskforge/shared';

/**
 * Regression coverage for the "collaborative team cumulative integration" bug:
 * a sequential pair/collaborative team chains agents on ONE shared worktree
 * (A -> commit A, B -> commit B, C -> commit C), but the integration pipeline
 * only ever cherry-picks a SINGLE commit hash into the run's integration
 * branch. Picking the wrong commit (or even just the *last* commit, whose
 * diff is only delta(B, C)) silently drops earlier team members' work from
 * the integrated result.
 */
describe('Collaborative/pair team cumulative integration', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-cumulative');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'TaskForge Team Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'team@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'base.txt'), 'baseline\n', 'utf8');
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

  function makeConfig() {
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.collaboration.maxAgentsPerTask = 3;
    return config;
  }

  async function readFromBranch(branch: string, filePath: string): Promise<string> {
    const out = await gitService.exec(['show', `${branch}:${filePath}`], testRepoRoot);
    return `${out}\n`;
  }

  async function listBranchFiles(branch: string): Promise<string[]> {
    const out = await gitService.exec(['ls-tree', '-r', '--name-only', branch], testRepoRoot);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  function router(strategy: RoutingDecision['strategy'], roles: RoutingDecision['roles']): RoutingProvider {
    return {
      id: `mock-${strategy}-router`,
      route: async () => ({
        strategy,
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'low',
        teamSize: roles.length,
        roles,
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: `Test-forced ${strategy} strategy`,
      }),
    };
  }

  it('integrates the complete cumulative state of a 2-member collaborative team (a.txt + b.txt)', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const agentA = new FakeAgent('agent-a', 'Agent A', [
      { writeFile: { path: 'a.txt', content: 'from A\n' }, gitCommitMessage: 'feat: add a.txt' },
    ]);
    const agentB = new FakeAgent('agent-b', 'Agent B', [
      { writeFile: { path: 'b.txt', content: 'from B\n' }, gitCommitMessage: 'feat: add b.txt' },
    ]);
    registry.register(agentA);
    registry.register(agentB);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config: makeConfig(),
      database: db,
      agentRegistry: registry,
      router: router('collaborative', [
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Create a.txt', preferredAgent: 'agent-a' },
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Create b.txt', preferredAgent: 'agent-b' },
      ]),
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-CUMUL-2',
      title: 'Two member collaborative team',
      description: 'a.txt then b.txt',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-CUMUL-2',
        objective: 'Add a.txt and b.txt',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['a.txt exists', 'b.txt exists'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Two member collaborative team', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(result.integrationBranch).toBeDefined();

    const files = await listBranchFiles(result.integrationBranch!);
    expect(files).toContain('a.txt');
    expect(files).toContain('b.txt');
    expect(files).toContain('base.txt');

    expect(await readFromBranch(result.integrationBranch!, 'a.txt')).toBe('from A\n');
    expect(await readFromBranch(result.integrationBranch!, 'b.txt')).toBe('from B\n');

    db.close();
  });

  it('integrates the complete cumulative state of a 3-member collaborative team including a baseline-file edit', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const registry = new AgentRegistry(false);

    const agentA = new FakeAgent('agent-a3', 'Agent A3', [
      { writeFile: { path: 'agent-a.txt', content: 'A output\n' }, gitCommitMessage: 'feat: add agent-a.txt' },
    ]);
    const agentB = new FakeAgent('agent-b3', 'Agent B3', [
      { writeFile: { path: 'agent-b.txt', content: 'B output\n' }, gitCommitMessage: 'feat: add agent-b.txt' },
    ]);
    const agentC = new FakeAgent('agent-c3', 'Agent C3', [
      { writeFile: { path: 'base.txt', content: 'baseline\nmodified by C\n' }, gitCommitMessage: 'fix: update base.txt' },
    ]);
    registry.register(agentA);
    registry.register(agentB);
    registry.register(agentC);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config: makeConfig(),
      database: db,
      agentRegistry: registry,
      router: router('collaborative', [
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Create agent-a.txt', preferredAgent: 'agent-a3' },
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Create agent-b.txt', preferredAgent: 'agent-b3' },
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Modify base.txt', preferredAgent: 'agent-c3' },
      ]),
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-CUMUL-3',
      title: 'Three member collaborative team',
      description: 'a, b, then base.txt edit',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-CUMUL-3',
        objective: 'Add agent-a.txt, agent-b.txt and update base.txt',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['All three changes present'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Three member collaborative team', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(result.integrationBranch).toBeDefined();

    // Regression guard: if TaskForge only integrated the LAST member's commit
    // (delta(B, C) = base.txt edit only), agent-a.txt and agent-b.txt would be
    // silently missing here even though the task reports success.
    const files = await listBranchFiles(result.integrationBranch!);
    expect(files).toContain('agent-a.txt');
    expect(files).toContain('agent-b.txt');
    expect(files).toContain('base.txt');

    expect(await readFromBranch(result.integrationBranch!, 'agent-a.txt')).toBe('A output\n');
    expect(await readFromBranch(result.integrationBranch!, 'agent-b.txt')).toBe('B output\n');
    expect(await readFromBranch(result.integrationBranch!, 'base.txt')).toBe('baseline\nmodified by C\n');

    const events = eventRepo.listByRun(result.runId);
    const cumulEvent = events.find(
      (e) => e.type === 'TEAM_CUMULATIVE_INTEGRATION' && e.taskId === 'TASK-CUMUL-3',
    );
    expect(cumulEvent).toBeDefined();
    expect(cumulEvent?.payload?.teamCommitCount).toBe(3);

    db.close();
  });

  it('preserves both edits when a later team member sequentially edits the SAME file a prior member touched', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const registry = new AgentRegistry(false);

    const agentA = new FakeAgent('agent-a-same', 'Agent A Same File', [
      {
        writeFile: { path: 'shared.txt', content: 'line from A\n' },
        gitCommitMessage: 'feat: A writes shared.txt',
      },
    ]);
    const agentB = new FakeAgent('agent-b-same', 'Agent B Same File', [
      {
        writeFile: { path: 'shared.txt', content: 'line from A\nline from B\n' },
        gitCommitMessage: 'feat: B extends shared.txt built on A',
      },
    ]);
    registry.register(agentA);
    registry.register(agentB);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config: makeConfig(),
      database: db,
      agentRegistry: registry,
      router: router('collaborative', [
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Write shared.txt', preferredAgent: 'agent-a-same' },
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Extend shared.txt', preferredAgent: 'agent-b-same' },
      ]),
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-CUMUL-SAMEFILE',
      title: 'Same file sequential edit',
      description: 'B builds on A within the same shared worktree',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-CUMUL-SAMEFILE',
        objective: 'Sequentially edit shared.txt',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['shared.txt contains both contributions'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Same file sequential edit', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(result.integrationBranch).toBeDefined();

    // The integrated file must reflect B's final state, which itself was built
    // on top of A's commit in the shared worktree (proving the handoff, not an
    // independent overwrite).
    expect(await readFromBranch(result.integrationBranch!, 'shared.txt')).toBe('line from A\nline from B\n');

    const events = eventRepo.listByRun(result.runId);
    const cumulEvent = events.find(
      (e) => e.type === 'TEAM_CUMULATIVE_INTEGRATION' && e.taskId === 'TASK-CUMUL-SAMEFILE',
    );
    // Two distinct sequential commits (A's, then B's) produced the final state.
    expect(cumulEvent?.payload?.teamCommitCount).toBe(2);

    db.close();
  });

  it('does not integrate a partial team result when a later member fails after an earlier member succeeded', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const eventRepo = new EventRepository(db);
    const registry = new AgentRegistry(false);

    const agentA = new FakeAgent('agent-a-fail', 'Agent A Before Failure', [
      {
        writeFile: { path: 'partial.txt', content: 'A got this far\n' },
        gitCommitMessage: 'feat: A commits before B fails',
      },
    ]);
    const agentB = new FakeAgent('agent-b-fail', 'Agent B Fails', [
      { shouldFail: true, failMessage: 'Agent B could not complete its part' },
    ]);
    registry.register(agentA);
    registry.register(agentB);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config: makeConfig(),
      database: db,
      agentRegistry: registry,
      router: router('collaborative', [
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Write partial.txt', preferredAgent: 'agent-a-fail' },
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Finish the job', preferredAgent: 'agent-b-fail' },
      ]),
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-CUMUL-PARTIAL-FAIL',
      title: 'Partial progress then failure',
      description: 'A succeeds, B fails',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-CUMUL-PARTIAL-FAIL',
        objective: 'Write partial.txt then finish',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Full job completed'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Partial progress then failure', { preplannedGraph: graph });

    expect(result.status).not.toBe('completed');
    expect(result.tasksFailed).toBeGreaterThan(0);
    // Nothing was integrated: the run must not claim the task's (partial) result succeeded.
    expect(result.integrationBranch).toBeUndefined();

    const events = eventRepo.listByRun(result.runId);
    const cumulEvent = events.find(
      (e) => e.type === 'TEAM_CUMULATIVE_INTEGRATION' && e.taskId === 'TASK-CUMUL-PARTIAL-FAIL',
    );
    expect(cumulEvent).toBeUndefined();

    db.close();
  });

  it('gives pair strategy the same cumulative-state guarantee as collaborative', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);

    const lead = new FakeAgent('pair-lead', 'Pair Lead', [
      { writeFile: { path: 'pair-a.txt', content: 'lead output\n' }, gitCommitMessage: 'feat: lead implements' },
    ]);
    const partner = new FakeAgent('pair-partner', 'Pair Partner', [
      { writeFile: { path: 'pair-b.txt', content: 'partner output\n' }, gitCommitMessage: 'feat: partner adds validation' },
    ]);
    registry.register(lead);
    registry.register(partner);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config: makeConfig(),
      database: db,
      agentRegistry: registry,
      router: router('pair', [
        { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Implement', preferredAgent: 'pair-lead' },
        { role: 'reviewer', requiredCapabilities: ['canWrite'], objective: 'Pair and validate', preferredAgent: 'pair-partner' },
      ]),
      gitService,
      worktreeManager,
    });

    const graph = new TaskGraph();
    const task: Task = {
      id: 'TASK-CUMUL-PAIR',
      title: 'Pair strategy cumulative guarantee',
      description: 'lead then partner',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        taskId: 'TASK-CUMUL-PAIR',
        objective: 'Pair implement',
        allowedScope: ['**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['pair-a.txt and pair-b.txt exist'],
      },
    };
    graph.addTask(task);

    const result = await orchestrator.run('Pair strategy', { preplannedGraph: graph });

    expect(result.status).toBe('completed');
    expect(result.integrationBranch).toBeDefined();

    const files = await listBranchFiles(result.integrationBranch!);
    expect(files).toContain('pair-a.txt');
    expect(files).toContain('pair-b.txt');

    db.close();
  });
});
