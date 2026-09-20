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
import {
  FakeAgent,
  AgentRegistry,
  CodexAdapter,
  AntigravityAdapter,
  ClaudeCodeAdapter,
} from '@taskforge/agents';
import { TaskGraph, Task, Goal } from '@taskforge/core';
import {
  TaskGraphValidator,
  SemanticPlanner,
  RawPlanOutput,
} from '@taskforge/planner';
import {
  RoutingQualityGuard,
  AdaptiveRoutingProvider,
  StaticRoutingProvider,
} from '@taskforge/router';
import { OperatorIntentParser, OperatorAgent } from '@taskforge/operator';
import { InteractiveShell, TerminalViewport } from '@taskforge/conversation';
import {
  getDefaultConfig,
  generateRunId,
  TaskForgeConfig,
} from '@taskforge/shared';
import {
  CompletionGate,
  sanitizeTaskOutput,
} from '../src/completion-gate.js';
import { DeterministicScheduler } from '../src/deterministic-scheduler.js';
import { RunOrchestrator } from '../src/run-orchestrator.js';

describe('Self-Hosting Readiness Hardening Suite (Requirements 20 & 24.A-O)', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-self-hosting');
  let gitService: GitService;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService['exec'](['init', '-b', 'main'], testRepoRoot);
    await gitService['exec'](['config', 'user.name', 'Self-Hosting Bot'], testRepoRoot);
    await gitService['exec'](['config', 'user.email', 'self-hosting@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(
      path.join(testRepoRoot, 'package.json'),
      JSON.stringify({ name: 'taskforge-dogfood-target', version: '1.0.0' }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Self-Hosting Target\n', 'utf8');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
    worktreeManager = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
  });

  afterEach(async () => {
    await worktreeManager.prune().catch(() => {});
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore cleanup error
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test A: Multiline prompt submission via bracketed paste produces 1 turn
  // ──────────────────────────────────────────────────────────────────────────
  it('A. Bracketed paste produces a single user turn with full multiline prompt intact', () => {
    const multilinePrompt = [
      'Refactor the TaskForge runtime to support resilient sessions:',
      '1. Implement GovernedAssignment with state machine.',
      '2. Ensure CompletionGate verifies commits before marking success.',
      '3. Enforce single authoritative run IDs across all events.',
    ].join('\n');

    // Verify parser handles multiline input as a single submit_goal without splitting
    const intent = OperatorIntentParser.parse(multilinePrompt);
    expect(intent.type).toBe('submit_goal');
    if (intent.type === 'submit_goal') {
      expect(intent.goal).toBe(multilinePrompt);
      expect(intent.goal.split('\n').length).toBe(4);
    }

    // Verify TerminalViewport renders multiline buffer using symbol without blowing up rows
    let rendered = '';
    const mockStream = {
      write: (str: string) => {
        rendered += str;
      },
      isTTY: true,
      rows: 24,
      columns: 80,
    } as unknown as NodeJS.WriteStream;

    const viewport = new TerminalViewport(mockStream, { interactive: true });
    viewport.renderInputLine(multilinePrompt, multilinePrompt.length, 'IDLE');
    expect(rendered).toContain(' ↵ ');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test B: Plan feedback in AWAITING_PLAN_APPROVAL revises plan
  // ──────────────────────────────────────────────────────────────────────────
  it('B. Natural language plan feedback in AWAITING_PLAN_APPROVAL produces a revised plan', () => {
    const feedbackText = 'Do not modify package.json and please split TASK-01 into smaller tasks';
    const context = {
      conversationState: 'AWAITING_PLAN_APPROVAL' as const,
      hasActivePlan: true,
      pendingInteractionsCount: 0,
    };

    const intent = OperatorIntentParser.parse(feedbackText, context);
    expect(intent.type).toBe('revise_plan');
    if (intent.type === 'revise_plan') {
      expect(intent.revision.type).toBe('split_task');
      expect(intent.revision.taskId).toBe('TASK-01');
      expect(intent.revision.details).toBe(feedbackText);
    }

    const constraintFeedback = 'Must not change any environment files or database schemas';
    const constraintIntent = OperatorIntentParser.parse(constraintFeedback, context);
    expect(constraintIntent.type).toBe('revise_plan');
    if (constraintIntent.type === 'revise_plan') {
      expect(constraintIntent.revision.type).toBe('add_constraint');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test C: Semantic planner produces structured tasks with contracts and validates >= 4 tasks
  // ──────────────────────────────────────────────────────────────────────────
  it('C. Semantic planner validates structured tasks and rejects fewer than 4 tasks for complex goals', async () => {
    // 1. Rejects collapsed plan (< 4 tasks for cross-cutting goal)
    const collapsedPlan: RawPlanOutput = {
      summary: 'Collapsed two-task plan',
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Do everything',
          description: 'Refactor all runtime files',
          type: 'implementation',
          dependencies: [],
          objective: 'Refactor',
          allowedScope: ['*'],
          forbiddenChanges: [],
          acceptanceCriteria: ['All done'],
        },
        {
          taskId: 'TASK-02',
          title: 'Review',
          description: 'Review everything',
          type: 'review',
          dependencies: ['TASK-01'],
          objective: 'Review',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['Pass'],
        },
      ],
    };

    const validationCollapsed = TaskGraphValidator.validate(collapsedPlan, 'goal-dogfood', { minTasks: 4 });
    expect(validationCollapsed.valid).toBe(false);
    expect(validationCollapsed.errors).toContain('Plan contains only 2 tasks, which is fewer than required minimum (4)');

    // 2. Rejects plan missing required contract fields
    const missingContractPlan: RawPlanOutput = {
      summary: 'Plan with missing fields',
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'T1',
          description: 'D1',
          type: 'implementation',
          dependencies: [],
          objective: '', // empty
          allowedScope: [],
          forbiddenChanges: [],
          acceptanceCriteria: [],
        },
        { taskId: 'TASK-02', title: 'T2', description: 'D2', type: 'implementation', dependencies: ['TASK-01'], objective: 'O2', allowedScope: ['*'], forbiddenChanges: [], acceptanceCriteria: ['A2'] },
        { taskId: 'TASK-03', title: 'T3', description: 'D3', type: 'implementation', dependencies: ['TASK-02'], objective: 'O3', allowedScope: ['*'], forbiddenChanges: [], acceptanceCriteria: ['A3'] },
        { taskId: 'TASK-04', title: 'T4', description: 'D4', type: 'review', dependencies: ['TASK-03'], objective: 'O4', allowedScope: [], forbiddenChanges: ['*'], acceptanceCriteria: ['A4'] },
      ],
    };
    const validationMissing = TaskGraphValidator.validate(missingContractPlan, { minTasks: 4 });
    expect(validationMissing.valid).toBe(false);
    expect(validationMissing.errors.some((e) => e.includes('objective'))).toBe(true);

    // 3. Validates and generates TaskGraph when 4+ valid structured tasks are provided
    const validPlan: RawPlanOutput = {
      summary: 'Self-hosting hardening multi-task plan',
      tasks: [
        {
          taskId: 'TASK-01',
          title: 'Investigate runtime lifecycle and failure modes',
          description: 'Analyze how dogfood failure occurred',
          type: 'investigation',
          dependencies: [],
          objective: 'Identify why exit 0 masked denied actions',
          allowedScope: ['packages/agents/**', 'packages/scheduler/**'],
          forbiddenChanges: ['package.json'],
          acceptanceCriteria: ['Failure modes documented in investigation report'],
        },
        {
          taskId: 'TASK-02',
          title: 'Implement CompletionGate and outcome normalization',
          description: 'Ensure CLI exit code 0 does not imply completion when actions denied',
          type: 'implementation',
          dependencies: ['TASK-01'],
          objective: 'Add CompletionGate in scheduler and normalize outcomes in agents',
          allowedScope: ['packages/scheduler/src/**', 'packages/agents/src/**'],
          forbiddenChanges: ['packages/conversation/**'],
          acceptanceCriteria: ['CompletionGate rejects REQUIRED_ACTION_DENIED and NO_CHANGES_PRODUCED'],
        },
        {
          taskId: 'TASK-03',
          title: 'Enforce authoritative Run ID and output sanitization',
          description: 'Pass single runId and strip raw JSONL envelopes',
          type: 'implementation',
          dependencies: ['TASK-02'],
          objective: 'Fix run ID discrepancies and raw JSON output',
          allowedScope: ['packages/conversation/src/**', 'packages/scheduler/src/**'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Single runId across all tables', 'Human-readable output format'],
        },
        {
          taskId: 'TASK-04',
          title: 'Independent Architecture and Security Review',
          description: 'Review diff and verify self-hosting readiness invariants',
          type: 'review',
          dependencies: ['TASK-03'],
          objective: 'Verify no regressions and dogfood safety',
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['All invariants verified and review findings recorded'],
        },
      ],
    };

    const planner = new SemanticPlanner({
      customCaller: async () => validPlan,
    });

    const graph = await planner.plan({
      id: 'goal-dogfood',
      description: 'Refactor TaskForge runtime for self-hosting reliability',
      repository: testRepoRoot,
      constraints: [],
      acceptanceCriteria: [],
    });

    expect(graph.getAllTasks().length).toBe(4);
    const t2 = graph.getTask('TASK-02');
    expect(t2).toBeDefined();
    expect(t2?.contract.objective).toBe('Add CompletionGate in scheduler and normalize outcomes in agents');
    expect(t2?.contract.forbiddenChanges).toContain('packages/conversation/**');
    expect(t2?.contract.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test D: Quality guard upgrades runtime refactoring to high complexity/risk
  // ──────────────────────────────────────────────────────────────────────────
  it('D. Quality guard classifies cross-cutting runtime refactoring as high complexity and risk', () => {
    const task: Task = {
      id: 'TASK-01',
      goalId: 'goal-refactor',
      title: 'Refactor SessionRegistry and ConcurrencyManager in scheduler runtime',
      description: 'Cross-cutting refactor touching packages/scheduler and packages/execution',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Refactor scheduler concurrency and lifecycle',
        allowedScope: ['packages/scheduler/**', 'packages/execution/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['All tests pass'],
        dependencies: [],
      },
      acceptanceCriteria: ['All tests pass'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const evaluation = RoutingQualityGuard.evaluateTask(task);
    expect(evaluation.isCrossCuttingRuntime).toBe(true);
    expect(evaluation.shouldUpgrade).toBe(true);
    expect(evaluation.recommendedComplexity).toBe('high');
    expect(evaluation.recommendedRisk).toBe('high');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test E: Adaptive routing provider records explicit provenance
  // ──────────────────────────────────────────────────────────────────────────
  it('E. Adaptive routing provider records explicit provenance metadata on routing decisions', async () => {
    const provider = new AdaptiveRoutingProvider();
    const task: Task = {
      id: 'TASK-01',
      goalId: 'goal-test',
      title: 'Refactor concurrency runtime and scheduler execution',
      description: 'Modify scheduler core logic',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Refactor scheduler',
        allowedScope: ['packages/scheduler/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Done'],
        dependencies: [],
      },
      acceptanceCriteria: ['Done'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const decision = await provider.route({
      task,
      availableAgents: ['codex', 'claude', 'antigravity'],
    });

    expect(decision.provenance).toBeDefined();
    expect(decision.provenance?.source).toBe('adaptive');
    expect(decision.complexity).toBe('high');
    expect(decision.risk).toBe('high');
    expect(decision.provenance?.policyAdjustment).toBeDefined();
    expect(decision.provenance?.policyAdjustment?.crossCuttingRuntimeUpgrade).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test F: Single authoritative run ID across all records and events
  // ──────────────────────────────────────────────────────────────────────────
  it('F. Enforces a single authoritative run ID across run, tasks, assignments, executions, and events', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const runRepo = new RunRepository(db);
    const taskRepo = new TaskRepository(db);
    const assignmentRepo = new AssignmentRepository(db);
    const executionRepo = new ExecutionRepository(db);
    const eventRepo = new EventRepository(db);

    const authoritativeRunId = generateRunId();
    const fakeAgent = new FakeAgent('fake-run-agent', 'Fake Run Agent', [
      {
        writeFile: {
          path: 'authoritative-test.ts',
          content: 'export const test = 1;\n',
        },
        gitCommitMessage: 'feat: authoritative test',
      },
    ]);

    const registry = new AgentRegistry(false);
    registry.register(fakeAgent);

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      database: db,
      agentRegistry: registry,
    });

    const graph = new TaskGraph();
    graph.addTask({
      id: 'TASK-01',
      goalId: 'goal-run-id',
      title: 'Verify single run ID',
      description: 'Ensure runId consistency',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Ensure runId consistency',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Run ID identical across all subsystems'],
        dependencies: [],
      },
      acceptanceCriteria: ['Run ID identical across all subsystems'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await orchestrator.run('Verify single run ID', {
      runId: authoritativeRunId,
      preplannedGraph: graph,
      fakeFallback: true,
    });

    expect(result.runId).toBe(authoritativeRunId);

    // Verify DB Run record
    const runRecord = runRepo.get(authoritativeRunId);
    expect(runRecord).toBeDefined();
    expect(runRecord?.id).toBe(authoritativeRunId);

    // Verify DB Tasks
    const tasks = taskRepo.listByRun(authoritativeRunId);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.runId === authoritativeRunId)).toBe(true);

    // Verify DB Assignments
    const assignments = assignmentRepo.listByRun(authoritativeRunId);
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((a) => a.runId === authoritativeRunId)).toBe(true);

    // Verify DB Executions
    const executions = executionRepo.listByRun(authoritativeRunId);
    expect(executions.length).toBeGreaterThan(0);
    expect(executions.every((e) => e.runId === authoritativeRunId)).toBe(true);

    // Verify DB Events
    const events = eventRepo.listByRun(authoritativeRunId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((ev) => ev.runId === authoritativeRunId)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test G: Provider exit 0 + required action denied => REQUIRED_ACTION_DENIED
  // ──────────────────────────────────────────────────────────────────────────
  it('G. Provider exit 0 after required action denial marks task failed with REQUIRED_ACTION_DENIED', async () => {
    const completionGate = new CompletionGate(gitService);
    const task: Task = {
      id: 'TASK-01',
      goalId: 'goal-denial',
      title: 'RunCommand test',
      description: 'Attempt command execution that is denied by policy',
      type: 'implementation',
      status: 'in_progress',
      dependencies: [],
      contract: {
        objective: 'Execute build command',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Command succeeds'],
        dependencies: [],
      },
      acceptanceCriteria: ['Command succeeds'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Simulate AntigravityAdapter outcome where process exited 0 but RunCommand was denied
    const agentResult = {
      success: false,
      message: 'Agent completed work but required actions were denied: RunCommand(pnpm build)',
      durationMs: 1200,
      completionReason: 'REQUIRED_ACTION_DENIED' as const,
      normalizedOutcome: {
        processExitCode: 0,
        providerStatus: 'FAILED' as const,
        finalResponse: 'I was unable to complete the task because RunCommand was denied.',
        deniedActions: [
          {
            action: 'RunCommand',
            tool: 'execute_command',
            resource: 'pnpm build',
            reason: 'Denied by user policy',
          },
        ],
        unresolvedInteractions: [],
        errors: ['Action denied: RunCommand(pnpm build)'],
        warnings: [],
        artifacts: [],
      },
    };

    const gateResult = await completionGate.evaluate({
      task,
      agentResult,
      gitService,
      baseCommit: await gitService.getHeadCommit(),
      resultingCommit: await gitService.getHeadCommit(),
    });

    expect(gateResult.accepted).toBe(false);
    expect(gateResult.failureReason).toBe('REQUIRED_ACTION_DENIED');
    expect(gateResult.evidence.deniedActions?.length).toBe(1);
    expect(gateResult.evidence.deniedActions?.[0].action).toBe('RunCommand');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test H: Provider exit 0 + zero diff implementation => NO_CHANGES_PRODUCED
  // ──────────────────────────────────────────────────────────────────────────
  it('H. Implementation task producing zero file modifications is rejected with NO_CHANGES_PRODUCED', async () => {
    const completionGate = new CompletionGate(gitService);
    const task: Task = {
      id: 'TASK-01',
      goalId: 'goal-no-diff',
      title: 'Implement feature',
      description: 'Implement new feature',
      type: 'implementation',
      status: 'in_progress',
      dependencies: [],
      contract: {
        objective: 'Implement feature',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Feature code written'],
        dependencies: [],
      },
      acceptanceCriteria: ['Feature code written'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const headCommit = await gitService.getHeadCommit();

    // Agent reported success and exited 0, but no files were modified or committed
    const agentResult = {
      success: true,
      message: 'I have finished all tasks successfully.',
      durationMs: 2500,
      commitHash: headCommit,
      normalizedOutcome: {
        processExitCode: 0,
        providerStatus: 'SUCCESS' as const,
        finalResponse: 'All tasks completed successfully.',
        deniedActions: [],
        unresolvedInteractions: [],
        errors: [],
        warnings: [],
        artifacts: [],
      },
    };

    const gateResult = await completionGate.evaluate({
      task,
      agentResult,
      gitService,
      baseCommit: headCommit,
      resultingCommit: headCommit,
    });

    expect(gateResult.accepted).toBe(false);
    expect(gateResult.failureReason).toBe('NO_CHANGES_PRODUCED');
    expect(gateResult.evidence.commitsProduced?.length).toBe(0);
    expect(gateResult.evidence.filesModified?.length).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test I: Investigation w/o diff allowed with substantive report
  // ──────────────────────────────────────────────────────────────────────────
  it('I. Investigation task producing zero diff is accepted when substantive report is present', async () => {
    const completionGate = new CompletionGate(gitService);
    const task: Task = {
      id: 'TASK-01',
      goalId: 'goal-investigate',
      title: 'Investigate deadlock in scheduler',
      description: 'Investigate deadlock conditions',
      type: 'investigation',
      status: 'in_progress',
      dependencies: [],
      contract: {
        objective: 'Identify root cause of deadlock',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Root cause documented'],
        dependencies: [],
      },
      acceptanceCriteria: ['Root cause documented'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const headCommit = await gitService.getHeadCommit();
    const substantiveReport = [
      '### Investigation Findings',
      'The scheduler deadlock occurs due to mutex contention between ConcurrencyManager',
      'and GovernedAssignment during session transitions. When two tasks finish concurrently,',
      'the releaseSession call blocks waiting on the SessionRegistry lock.',
    ].join('\n');

    const agentResult = {
      success: true,
      message: 'Investigation completed',
      output: substantiveReport,
      durationMs: 1500,
    };

    const gateResult = await completionGate.evaluate({
      task,
      agentResult,
      gitService,
      baseCommit: headCommit,
      resultingCommit: headCommit,
    });

    expect(gateResult.accepted).toBe(true);
    expect(gateResult.evidence.investigationReportLength).toBeGreaterThan(50);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test J: Review w/o diff allowed with review findings
  // ──────────────────────────────────────────────────────────────────────────
  it('J. Review task producing zero diff is accepted when review findings are provided', async () => {
    const completionGate = new CompletionGate(gitService);
    const task: Task = {
      id: 'TASK-02',
      goalId: 'goal-review',
      title: 'Review implementation changes',
      description: 'Code review for edge cases',
      type: 'review',
      status: 'in_progress',
      dependencies: [],
      contract: {
        objective: 'Independent review',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Review findings reported'],
        dependencies: [],
      },
      acceptanceCriteria: ['Review findings reported'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const headCommit = await gitService.getHeadCommit();
    const agentResult = {
      success: true,
      message: 'Review completed with 2 findings',
      findings: [
        {
          file: 'packages/scheduler/src/completion-gate.ts',
          line: 120,
          severity: 'warning' as const,
          message: 'Ensure fallback GitService is instantiated if not injected',
        },
      ],
      durationMs: 1800,
    };

    const gateResult = await completionGate.evaluate({
      task,
      agentResult,
      gitService,
      baseCommit: headCommit,
      resultingCommit: headCommit,
    });

    expect(gateResult.accepted).toBe(true);
    expect(gateResult.evidence.reviewFindingsCount).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test K: Raw JSONL never becomes Explanation & Analysis
  // ──────────────────────────────────────────────────────────────────────────
  it('K. sanitizeTaskOutput extracts human-readable text and strips raw JSON/JSONL envelopes', () => {
    const rawJsonlStream = [
      '{"type":"init","session_id":"sess-123","model":"antigravity-luna"}',
      '{"type":"thought","content":"Analyzing codebase architecture..."}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I have verified the runtime hardening fixes across all packages."}]}}',
      '{"type":"status","code":0}',
    ].join('\n');

    const sanitized = sanitizeTaskOutput(rawJsonlStream);

    expect(sanitized).not.toContain('{"type":');
    expect(sanitized).not.toContain('"session_id"');
    expect(sanitized).toContain('I have verified the runtime hardening fixes across all packages.');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test L: Codex CLI harness stdin mode: close_after_spawn
  // ──────────────────────────────────────────────────────────────────────────
  it('L. CodexAdapter specifies stdinMode close_after_spawn and normalizes outcome', () => {
    const codex = new CodexAdapter();
    expect(codex.stdinMode).toBe('close_after_spawn');
    expect(codex.permissionProtocol).toBe('provider_native');

    const normalized = codex.normalizeOutcome(
      'Codex completed assignment successfully.',
      '',
      0,
    );
    expect(normalized.processExitCode).toBe(0);
    expect(normalized.providerStatus).toBe('SUCCESS');
    expect(normalized.finalResponse).toContain('Codex completed assignment successfully.');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test M: Antigravity / Claude CLI harness stdin mode: interactive
  // ──────────────────────────────────────────────────────────────────────────
  it('M. Antigravity and Claude adapters specify stdinMode interactive with structured protocol', () => {
    const antigravity = new AntigravityAdapter();
    expect(antigravity.stdinMode).toBe('interactive');
    expect(antigravity.permissionProtocol).toBe('structured');

    const claude = new ClaudeCodeAdapter();
    expect(claude.stdinMode).toBe('interactive');
    expect(claude.permissionProtocol).toBe('structured');

    // Test denied action parsing in normalizeOutcome
    const outcomeWithDenial = antigravity.normalizeOutcome(
      'Error: Permission was denied for action RunCommand(pnpm test)',
      '',
      0,
    );
    expect(outcomeWithDenial.providerStatus).toBe('FAILED');
    expect(outcomeWithDenial.deniedActions.length).toBeGreaterThan(0);
    expect(outcomeWithDenial.deniedActions[0].action).toBe('RunCommand');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test N: Pre-existing green tests cannot cause zero-work implementation to pass
  // ──────────────────────────────────────────────────────────────────────────
  it('N. Pre-existing green tests cannot cause a zero-work implementation task to complete', async () => {
    const completionGate = new CompletionGate(gitService);
    const task: Task = {
      id: 'TASK-01',
      goalId: 'goal-green-tests',
      title: 'Zero diff implementation with green tests',
      description: 'Agent produces no changes but tests pass',
      type: 'implementation',
      status: 'in_progress',
      dependencies: [],
      contract: {
        objective: 'Write implementation',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Tests pass and code written'],
        dependencies: [],
      },
      acceptanceCriteria: ['Tests pass and code written'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const headCommit = await gitService.getHeadCommit();
    const agentResult = {
      success: true,
      message: 'All done',
      durationMs: 1000,
    };

    // Even if verificationPassed is TRUE, CompletionGate must reject because filesModified and commitsProduced are 0!
    const gateResult = await completionGate.evaluate({
      task,
      agentResult,
      gitService,
      baseCommit: headCommit,
      resultingCommit: headCommit,
      verificationPassed: true, // preexisting green tests
    });

    expect(gateResult.accepted).toBe(false);
    expect(gateResult.failureReason).toBe('NO_CHANGES_PRODUCED');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test O: Full end-to-end self-hosting regression fixture (Requirement 20)
  // ──────────────────────────────────────────────────────────────────────────
  it('O. Full self-hosting regression fixture fails safely on denied action without false completion', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const authoritativeRunId = generateRunId();

    // 1. Create a FakeAgent that simulates the Antigravity dogfood failure:
    // Process exits 0, but requestPermission is denied, producing 0 commits.
    const failingAntigravitySimulation = new FakeAgent('antigravity', 'Simulated Antigravity CLI', [
      {
        requestPermission: {
          category: 'shell',
          operation: 'RunCommand',
          resource: 'pnpm build',
          prompt: 'Execute shell command to build packages',
        },
        shouldFail: false, // process exits 0
      },
    ]);

    const registry = new AgentRegistry(false);
    registry.register(failingAntigravitySimulation);

    // 2. Set up orchestrator with headless auto-denial policy
    const config = getDefaultConfig();
    config.ui = { mode: 'headless' };
    config.headless = {
      ...config.headless,
      onUnknownPermission: 'deny',
    };
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      database: db,
      agentRegistry: registry,
      config,
    });

    // 3. Create a 4-task structured graph representing the dogfood goal
    const graph = new TaskGraph();
    graph.addTask({
      id: 'TASK-01',
      goalId: 'goal-dogfood',
      title: 'Investigate runtime issues',
      description: 'Investigate failure modes and root causes of runtime failure',
      type: 'investigation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Investigate failure modes',
        allowedScope: ['*'],
        forbiddenChanges: ['package.json'],
        acceptanceCriteria: ['Investigation report generated'],
        dependencies: [],
      },
      acceptanceCriteria: ['Report generated'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    graph.addTask({
      id: 'TASK-02',
      goalId: 'goal-dogfood',
      title: 'Implement runtime hardening fixes',
      description: 'Apply fixes for denied actions and completion verification',
      type: 'implementation',
      status: 'proposed',
      dependencies: ['TASK-01'],
      contract: {
        objective: 'Apply fixes for denied actions and completion verification',
        allowedScope: ['packages/scheduler/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Fixes implemented'],
        dependencies: ['TASK-01'],
      },
      acceptanceCriteria: ['Fixes implemented'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 4. Run orchestrator
    const result = await orchestrator.run('Refactor runtime for self-hosting reliability', {
      runId: authoritativeRunId,
      preplannedGraph: graph,
    });

    // 5. Invariants verified:
    // A. TaskForge did NOT falsely report completion
    expect(result.status).not.toBe('completed');
    expect(result.status).toBe('failed');

    // B. Single authoritative run ID is preserved
    expect(result.runId).toBe(authoritativeRunId);

    // C. Task repository records failure
    const taskRepo = new TaskRepository(db);
    const t1 = taskRepo.get('TASK-01');
    expect(t1?.status).toBe('failed');

    // D. Assignment repository records completionReason as REQUIRED_ACTION_DENIED
    const assignmentRepo = new AssignmentRepository(db);
    const assignments = assignmentRepo.listByRun(authoritativeRunId);
    expect(assignments.length).toBeGreaterThan(0);
    const failedAssignment = assignments.find((a) => a.completionReason === 'REQUIRED_ACTION_DENIED');
    expect(failedAssignment).toBeDefined();

    // E. Event repository records COMPLETION_GATE_REJECTED
    const eventRepo = new EventRepository(db);
    const events = eventRepo.listByRun(authoritativeRunId);
    const gateRejectedEvent = events.find((e) => e.type === 'COMPLETION_GATE_REJECTED');
    expect(gateRejectedEvent).toBeDefined();
    expect(gateRejectedEvent?.payload.failureReason).toBe('REQUIRED_ACTION_DENIED');
  });
});
