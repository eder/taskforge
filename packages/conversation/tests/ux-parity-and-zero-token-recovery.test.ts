import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  getDefaultConfig,
  loadConfig,
  type ActiveAgentState,
  type AgentAssignment,
  type AgentCapabilities,
  type AgentContext,
  type AgentResult,
} from '@taskforge/shared';
import { AgentRegistry, type AgentAdapter } from '@taskforge/agents';
import { TaskForgeDatabase, RunRepository, TaskRepository, EventRepository } from '@taskforge/persistence';
import { TaskGraph, type Task } from '@taskforge/core';
import { RunOrchestrator, describeRunFailures } from '@taskforge/scheduler';
import { WorktreeManager, GitService } from '@taskforge/workspace';
import {
  parseDirectRouteCommand,
  parseNaturalConfigChange,
} from '../src/direct-agent-router.js';
import {
  DirectConversationMemory,
  DirectAgentRunner,
} from '../src/direct-agent-session.js';
import { buildRunFocus } from '../src/run-focus.js';
import { LiveTicker } from '../src/live-ticker.js';
import { InteractiveShell } from '../src/interactive-shell.js';

const tempDirs: string[] = [];

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ux-parity-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(dir, 'extra.ts'), 'export const extra = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function makeStubAdapter(
  id: string,
  name: string,
  handler: (assignment: AgentAssignment, context: AgentContext) => Promise<AgentResult>,
): AgentAdapter {
  return {
    id,
    name,
    detect: async () => true,
    capabilities: async (): Promise<AgentCapabilities> => ({
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['file_editor'],
    }),
    execute: handler,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Feature #1: Zero-token 1-Enter SCOPE_VIOLATION expansion & candidate reuse', () => {
  it('expands allowedScope and re-verifies kept candidate commit with 0 agent calls', async () => {
    const repo = createTempGitRepo();
    const db = new TaskForgeDatabase(':memory:');
    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.enforceScope = true;
    config.execution.maxReworkCycles = 0;

    let agentCalls = 0;
    const registry = new AgentRegistry(false);
    registry.register(
      makeStubAdapter('codex', 'Codex CLI', async (_assignment, ctx) => {
        agentCalls += 1;
        fs.writeFileSync(path.join(ctx.worktreePath, 'app.ts'), 'export const value = 2;\n');
        fs.writeFileSync(path.join(ctx.worktreePath, 'extra.ts'), 'export const extra = 2;\n');
        const git = new GitService(ctx.worktreePath);
        const commitHash = await git.stageAndCommit('feat: update app and extra', ctx.worktreePath);
        return {
          success: true,
          commitHash,
          message: 'Updated app.ts and extra.ts',
          output: 'Updated app.ts and extra.ts',
          durationMs: 25,
        };
      }),
    );

    const now = new Date();
    const task: Task = {
      id: 'TASK-53',
      goalId: 'goal-1',
      title: 'Update app logic',
      description: 'Update app.ts (and companion extra.ts)',
      type: 'implementation',
      status: 'accepted',
      dependencies: [],
      acceptanceCriteria: ['Update value'],
      contract: {
        objective: 'Update app.ts',
        allowedScope: ['app.ts'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Update value'],
        dependencies: [],
      },
      reworkCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const orchestrator = new RunOrchestrator({
      repoRoot: repo,
      config,
      database: db,
      agentRegistry: registry,
    });

    const first = await orchestrator.run('Update app logic', {
      runId: 'run-scope-001',
      preplannedGraph: new TaskGraph([task]),
    });

    expect(first.status).toBe('failed');
    const callsBeforeResume = agentCalls;
    expect(callsBeforeResume).toBeGreaterThanOrEqual(1);

    const taskRepo = new TaskRepository(db);
    const eventRepo = new EventRepository(db);
    const failures = describeRunFailures({ taskRepo, eventRepo }, 'run-scope-001');
    expect(failures).toHaveLength(1);
    expect(failures[0].scopeViolations).toEqual(['extra.ts']);
    expect(failures[0].keptBranch).toContain('taskforge/candidate/');

    const proposal = buildRunFocus({
      runId: 'run-scope-001',
      failures,
      repoRoot: repo,
    });
    expect(proposal.focus.action).toEqual({
      kind: 'expand_scope',
      expansions: [{ taskId: 'TASK-53', paths: ['extra.ts'] }],
    });
    expect(proposal.hint).toContain('0 tokens');

    // Expand persisted scope & resume reusing the preserved candidate directly
    const updatedScope = taskRepo.expandAllowedScope('TASK-53', ['extra.ts']);
    expect(updatedScope).toEqual(['app.ts', 'extra.ts']);

    const resumed = await orchestrator.resume('run-scope-001', {
      reuseCandidateTaskIds: ['TASK-53'],
    });
    expect(resumed.status).toBe('completed');
    // Zero additional agent calls during resume!
    expect(agentCalls).toBe(callsBeforeResume);

    const runRec = new RunRepository(db).get('run-scope-001');
    expect(runRec?.status).toBe('completed');
    db.close();
  });
});

describe('Feature #2: Native provider session continuity in DirectAgentRunner', () => {
  it('resumes same-agent sessions natively, injects only cross-agent deltas, and recovers from stale sessions', async () => {
    const repo = createTempGitRepo();
    const memory = new DirectConversationMemory();
    const registry = new AgentRegistry(false);

    const codexCalls: Array<{ sessionId?: string; history?: string; persist?: boolean }> = [];
    let failNextResumedCodex = false;

    registry.register(
      makeStubAdapter('codex', 'Codex CLI', async (_a, ctx) => {
        codexCalls.push({
          sessionId: ctx.providerSessionId,
          history: ctx.conversationHistory,
          persist: ctx.persistProviderSession,
        });
        if (failNextResumedCodex && ctx.providerSessionId) {
          failNextResumedCodex = false;
          return {
            success: false,
            message: 'Thread not found',
            output: '',
            durationMs: 10,
          };
        }
        return {
          success: true,
          message: 'ok',
          output: `Codex answer #${codexCalls.length}`,
          durationMs: 15,
          providerSessionId: ctx.providerSessionId ?? 'codex-thread-1',
        };
      }),
    );

    registry.register(
      makeStubAdapter('agy', 'Google Antigravity', async () => ({
        success: true,
        message: 'ok',
        output: 'AGY inspected memory.py and spotted a cache bug.',
        durationMs: 12,
        providerSessionId: 'agy-conv-1',
      })),
    );

    const runner = new DirectAgentRunner({
      repoRoot: repo,
      agentRegistry: registry,
      memory,
    });

    // Turn 1: fresh codex turn persists session id
    await runner.runAgents(['codex'], 'How does auth work?');
    expect(codexCalls[0].persist).toBe(true);
    expect(codexCalls[0].sessionId).toBeUndefined();
    expect(runner.getProviderSessionId('codex')).toBe('codex-thread-1');

    // Turn 2: consecutive turn to codex resumes natively with NO redundant history
    const turn2 = await runner.runAgents(['codex'], 'What about refresh tokens?');
    expect(codexCalls[1].sessionId).toBe('codex-thread-1');
    expect(codexCalls[1].history).toBeUndefined();
    expect(turn2.formatted).toContain('↻ resumed');

    // Turn 3: switch to AGY (records cross-agent turn)
    await runner.runAgents(['agy'], 'Check memory.py too');

    // Turn 4: back to codex -> resumes native session and receives ONLY AGY's delta
    await runner.runAgents(['codex'], 'Do you agree with AGY?');
    expect(codexCalls[2].sessionId).toBe('codex-thread-1');
    expect(codexCalls[2].history).toContain('spotted a cache bug');
    expect(codexCalls[2].history).not.toContain('How does auth work?');

    // Turn 5: simulate stale/expired provider session -> transparently retries fresh once
    failNextResumedCodex = true;
    const turn5 = await runner.runAgents(['codex'], 'Continue anyway');
    expect(turn5.outcomes[0].success).toBe(true);
    expect(codexCalls[3].sessionId).toBe('codex-thread-1'); // failed stale attempt
    expect(codexCalls[4].sessionId).toBeUndefined(); // fresh retry
    expect(codexCalls[4].history).toContain('spotted a cache bug');

    runner.clearSessions();
    expect(runner.getProviderSessionId('codex')).toBeUndefined();
  });
});

describe('Feature #3: @all Consensus & Divergences + @codex @agy --edit competitive worktrees', () => {
  it('appends Consensus & Divergences synthesis on multi-agent read-only turns', async () => {
    const repo = createTempGitRepo();
    const memory = new DirectConversationMemory();
    const registry = new AgentRegistry(false);

    registry.register(
      makeStubAdapter('codex', 'Codex CLI', async () => ({
        success: true,
        message: 'ok',
        output: 'Check app.ts and extra.ts for missing null guards.',
        durationMs: 10,
      })),
    );
    registry.register(
      makeStubAdapter('agy', 'Google Antigravity', async () => ({
        success: true,
        message: 'ok',
        output: 'Review app.ts for race conditions and config.yaml for timeouts.',
        durationMs: 12,
      })),
    );

    const runner = new DirectAgentRunner({
      repoRoot: repo,
      agentRegistry: registry,
      memory,
    });

    const result = await runner.runAgents(['codex', 'agy'], 'Audit this repo');
    expect(result.formatted).toContain('Consensus & Divergences');
    expect(result.formatted).toContain('app.ts');

    // Custom synthesizer path
    const customRunner = new DirectAgentRunner({
      repoRoot: repo,
      agentRegistry: registry,
      memory: new DirectConversationMemory(),
      consensusSynthesizer: async () => 'Consensus: both flagged app.ts.\nDivergences: AGY also flagged config.yaml.',
    });
    const customResult = await customRunner.runAgents(['codex', 'agy'], 'Audit this repo');
    expect(customResult.formatted).toContain('Consensus: both flagged app.ts.');
  });

  it('parses --edit flag and runs isolated competitive worktrees with 1-Enter winner apply', async () => {
    const parsed = parseDirectRouteCommand('@codex @agy --edit refactor app.ts', ['codex', 'agy']);
    expect(parsed).toEqual({
      kind: 'direct_agents',
      targets: ['codex', 'agy'],
      prompt: 'refactor app.ts',
      editMode: true,
    });

    const repo = createTempGitRepo();
    const memory = new DirectConversationMemory();
    const registry = new AgentRegistry(false);
    const git = new GitService(repo);
    const wtManager = new WorktreeManager(repo);

    registry.register(
      makeStubAdapter('codex', 'Codex CLI', async (_a, ctx) => {
        fs.writeFileSync(path.join(ctx.worktreePath, 'app.ts'), 'export const value = 100;\n');
        return { success: true, message: 'ok', output: 'Set value = 100', durationMs: 30 };
      }),
    );
    registry.register(
      makeStubAdapter('agy', 'Google Antigravity', async (_a, ctx) => {
        fs.writeFileSync(path.join(ctx.worktreePath, 'app.ts'), 'export const value = 42;\n');
        return { success: true, message: 'ok', output: 'Set value = 42', durationMs: 20 };
      }),
    );

    const runner = new DirectAgentRunner({
      repoRoot: repo,
      agentRegistry: registry,
      memory,
      gitService: git,
      worktreeManager: wtManager,
      verifyWorktree: async (wtPath) => {
        const content = fs.readFileSync(path.join(wtPath, 'app.ts'), 'utf8');
        const passed = content.includes('42');
        return { passed, summary: passed ? 'all tests passed' : 'expected 42' };
      },
    });

    const comp = await runner.runCompetitiveEdit(['codex', 'agy'], 'Set value to 42');
    expect(comp.pending).toBeDefined();
    expect(comp.pending!.candidates).toHaveLength(2);
    // AGY passed verification -> recommended #2
    expect(comp.pending!.recommendedIndex).toBe(2);
    expect(comp.formatted).toContain('★ recommended');
    expect(comp.formatted).toContain('✔ checks passed');
    expect(comp.formatted).toContain('✖ checks failed');

    // Main workspace must still be untouched before pick
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');

    // Inspect diff of candidate #2
    const diffOut = await runner.getCompetitiveCandidateDiff(comp.pending!, 2);
    expect(diffOut).toContain('export const value = 42;');

    // Apply candidate #2 cleanly to the working tree and verify temp worktrees are removed
    const applied = await runner.applyCompetitiveCandidate(comp.pending!, 2);
    expect(applied).toContain('Applied candidate');
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const value = 42;\n');
    expect(fs.existsSync(comp.pending!.candidates[0].worktreePath)).toBe(false);
    expect(fs.existsSync(comp.pending!.candidates[1].worktreePath)).toBe(false);
  });
});

describe('Feature #4: Natural-language parallelism & token budget configuration', () => {
  it('parses PT & EN parallelism and token budget commands without false positives on coding tasks', () => {
    const ptMulti = parseNaturalConfigChange('usa até 5 codex e 5 agy em paralelo');
    expect(ptMulti?.language).toBe('pt');
    expect(ptMulti?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyPath: ['agents', 'codex', 'maxParallel'], value: 5 }),
        expect.objectContaining({ keyPath: ['agents', 'agy', 'maxParallel'], value: 5 }),
        expect.objectContaining({ keyPath: ['execution', 'maxParallelTasks'], value: 10 }),
        expect.objectContaining({ keyPath: ['planner', 'maxTasks'], value: 10 }),
      ]),
    );

    const ptBudget = parseNaturalConfigChange('aumenta o limite de tokens para 4M');
    expect(ptBudget?.updates).toEqual([
      expect.objectContaining({ keyPath: ['execution', 'tokenBudget'], value: 4_000_000 }),
    ]);

    const ptUnlimited = parseNaturalConfigChange('sem limite de tokens');
    expect(ptUnlimited?.updates).toEqual([
      expect.objectContaining({ keyPath: ['execution', 'tokenBudget'], value: 0 }),
    ]);

    const enBoth = parseNaturalConfigChange('use up to 4 codex and 3 agy in parallel and set token budget to 2.5M');
    expect(enBoth?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyPath: ['agents', 'codex', 'maxParallel'], value: 4 }),
        expect.objectContaining({ keyPath: ['agents', 'agy', 'maxParallel'], value: 3 }),
        expect.objectContaining({ keyPath: ['execution', 'maxParallelTasks'], value: 7 }),
        expect.objectContaining({ keyPath: ['execution', 'tokenBudget'], value: 2_500_000 }),
      ]),
    );

    // Must NOT hijack normal coding tasks
    expect(parseNaturalConfigChange('implementa um worker pool com 5 threads em server/pool.py')).toBeUndefined();
    expect(parseNaturalConfigChange('quantos agentes em paralelo posso usar?')).toBeUndefined();
  });

  it('persists config changes to .taskforge/config.yaml and applies them live in InteractiveShell', async () => {
    const repo = createTempGitRepo();
    const db = new TaskForgeDatabase(':memory:');
    const shell = new InteractiveShell({
      repoRoot: repo,
      config: getDefaultConfig(),
      database: db,
      input: new PassThrough(),
      output: new PassThrough(),
      interactive: false,
      asyncExecution: false,
    });

    const reply = await shell.handleInput('usa até 5 codex e 5 agy em paralelo');
    expect(reply).toContain('Configuração atualizada');
    expect(reply).toContain('agents.codex.maxParallel = 5');
    expect(reply).toContain('agents.agy.maxParallel = 5');
    expect(reply).toContain('execution.maxParallelTasks = 10');

    const saved = loadConfig(path.join(repo, '.taskforge', 'config.yaml'));
    expect(saved.agents.codex?.maxParallel).toBe(5);
    expect(saved.agents.agy?.maxParallel).toBe(5);
    expect(saved.execution.maxParallelTasks).toBe(10);

    const budgetReply = await shell.handleInput('aumenta o limite de tokens para 4M');
    expect(budgetReply).toContain('4,000,000');
    const savedAfterBudget = loadConfig(path.join(repo, '.taskforge', 'config.yaml'));
    expect(savedAfterBudget.execution.tokenBudget).toBe(4_000_000);

    db.close();
  });
});

describe('Feature #5: Compact live multi-agent parallelism footer in LiveTicker', () => {
  it('renders parallelism summary bar, per-agent slot numbering, effective token spend, and custom maxVisibleRows', () => {
    const active: ActiveAgentState[] = [
      {
        taskId: 'TASK-1',
        assignmentId: 'a1',
        taskTitle: 'Task 1',
        agentId: 'codex',
        agentName: 'Codex CLI',
        role: 'implementer',
        status: 'Editing server/memory.py',
        startedAt: new Date(Date.now() - 12_000),
        lastActiveAt: new Date(),
      },
      {
        taskId: 'TASK-2',
        assignmentId: 'a2',
        taskTitle: 'Task 2',
        agentId: 'codex',
        agentName: 'Codex CLI',
        role: 'implementer',
        status: 'Editing server/search.py',
        startedAt: new Date(Date.now() - 8_000),
        lastActiveAt: new Date(),
      },
      {
        taskId: 'TASK-3',
        assignmentId: 'a3',
        taskTitle: 'Task 3',
        agentId: 'agy',
        agentName: 'Google Antigravity',
        role: 'researcher',
        status: 'Reviewing gateway/nginx.conf',
        startedAt: new Date(Date.now() - 4_000),
        lastActiveAt: new Date(),
      },
      {
        taskId: 'TASK-4',
        assignmentId: 'a4',
        taskTitle: 'Task 4',
        agentId: 'agy',
        agentName: 'Google Antigravity',
        role: 'tester',
        status: 'Running pytest',
        startedAt: new Date(Date.now() - 2_000),
        lastActiveAt: new Date(),
      },
    ];

    const lines = LiveTicker.render({
      activeAgents: active,
      maxParallelTasks: 10,
      effectiveTokensSpent: 185_000,
      maxVisibleRows: 6,
      frameIndex: 1,
    });
    const joined = lines.join('\n');

    expect(joined).toContain('⚡');
    expect(joined).toContain('4/10 active');
    expect(joined).toContain('codex ×2, agy ×2');
    expect(joined).toContain('185k eff tokens');
    expect(joined).toContain('[Codex CLI #1]');
    expect(joined).toContain('[Codex CLI #2]');
    expect(joined).toContain('[Google Antigravity #1]');
    expect(joined).toContain('[Google Antigravity #2]');
    expect(joined).toContain('TASK-4');
  });
});
