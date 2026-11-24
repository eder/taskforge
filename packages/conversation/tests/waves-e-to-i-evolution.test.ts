import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { AgentActivityTracker, AgentRegistry, type AgentAdapter } from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import {
  getDefaultConfig,
  type AgentAssignment,
  type AgentContext,
  type AgentResult,
} from '@taskforge/shared';
import {
  TerminalViewport,
  DirectTelemetryStore,
  DirectConversationMemory,
  DirectAgentRunner,
  DebateCouncilRunner,
  SpecialtyRouter,
  LifecycleHookRunner,
  BackgroundJobManager,
  resolveFileMentionsInPrompt,
  appendImageContextToPrompt,
  buildDeterministicLivingPlan,
  compileWaveToTaskGraph,
  addProjectMemoryEntry,
  loadProjectMemory,
  formatProjectMemoryForPrompt,
  parseNaturalMemoryCapture,
  discoverProjectSkills,
  expandSkillPrompt,
  parseGitHubAutopilotCommand,
  InteractiveShell,
} from '../src/index.js';

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-waves-ei-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const sum = (a: number, b: number) => a + b;\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

class EvolutionStubAdapter implements AgentAdapter {
  public calls: Array<{ taskId: string; prompt: string; priorContext?: string; mutationAllowed?: boolean }> = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly handler: (a: AgentAssignment, c: AgentContext) => Promise<AgentResult>,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities() {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['file_editor'],
      stdinMode: 'close_after_spawn' as const,
      permissionProtocol: 'provider_native' as const,
      questionProtocol: 'unsupported' as const,
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls.push({
      taskId: assignment.taskId,
      prompt: assignment.objective,
      priorContext: context.priorContext,
      mutationAllowed: context.mutationAllowed,
    });
    return this.handler(assignment, context);
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Waves E–I: Complete Unified Multi-Agent Terminal Evolution', () => {
  describe('Wave E: Dynamic Prompt Badge, Unified Telemetry, Live Activity & Image Attachments', () => {
    it('updates dynamic prompt badge width accurately in TerminalViewport', () => {
      const chunks: string[] = [];
      const stream = new PassThrough();
      stream.on('data', (c) => chunks.push(c.toString('utf8')));
      const vp = new TerminalViewport(stream, { interactive: true });
      expect(vp.computeVisualLines('hi', 2).cursorVisualCol).toBe(5); // `> ` (2) + 2 + 1

      vp.setModeBadge('auto');
      // `[auto] > ` = 4 + 5 = 9 visual cols -> typing `o` places cursor after `o` at col 9 + 1 + 1 = 11
      expect(vp.computeVisualLines('o', 1).cursorVisualCol).toBe(11);

      chunks.length = 0;
      vp.renderInputLine('o', 1);
      const rendered = chunks.join('');
      // eslint-disable-next-line no-control-regex
      const cursorMove = /\x1b\[\d+;(\d+)H$/.exec(rendered);
      expect(cursorMove?.[1]).toBe('11');

      vp.setModeBadge('@codex · o3');
      expect(vp.getModeBadge()).toBe('@codex · o3');
      // `[@codex · o3] > ` = 11 + 5 = 16 visual cols -> cursor at 16 + 2 + 1 = 19
      expect(vp.computeVisualLines('hi', 2).cursorVisualCol).toBe(19);
    });

    it('detects #image.png and absolute screenshot paths and appends multimodal image context', () => {
      const repoRoot = createTempRepo();
      tempDirs.push(repoRoot);
      const imgPath = path.join(repoRoot, 'ui-bug.png');
      fs.writeFileSync(imgPath, 'fake-png-bytes', 'utf8');

      const resolved = resolveFileMentionsInPrompt('fix alignment in #ui-bug.png and #index.ts', repoRoot);
      expect(resolved.files).toEqual(['ui-bug.png', 'index.ts']);
      expect(resolved.images).toEqual([imgPath]);

      const promptWithImages = appendImageContextToPrompt(resolved.cleanedPrompt, resolved.images);
      expect(promptWithImages).toContain('Attached image file(s) to inspect directly:');
      expect(promptWithImages).toContain(imgPath);
    });

    it('records Direct Mode turns into SQLite DirectTelemetryStore and drives live ActivityTracker', async () => {
      const repoRoot = createTempRepo();
      tempDirs.push(repoRoot);
      const db = new TaskForgeDatabase(':memory:');
      const telemetry = new DirectTelemetryStore(db);
      const tracker = new AgentActivityTracker();
      let sawActiveDuringTurn = false;

      const codex = new EvolutionStubAdapter('codex', 'Codex CLI', async () => {
        if (tracker.getActive().some((a) => a.agentId === 'codex')) {
          sawActiveDuringTurn = true;
        }
        return {
          success: true,
          message: 'Done',
          output: 'Done',
          durationMs: 120,
          usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 },
        };
      });

      const registry = new AgentRegistry(false);
      registry.register(codex);
      const runner = new DirectAgentRunner({
        repoRoot,
        agentRegistry: registry,
        memory: new DirectConversationMemory(),
        activityTracker: tracker,
        directTelemetry: telemetry,
      });

      await runner.runAgents(['codex'], 'explain index.ts');
      expect(sawActiveDuringTurn).toBe(true);
      expect(tracker.getActive()).toHaveLength(0); // cleaned up after completion

      // Reload from SQLite to confirm persistence
      const reloaded = new DirectTelemetryStore(db);
      expect(reloaded.list()).toHaveLength(1);
      expect(reloaded.list()[0].tokensUsed).toBe(1000);
      expect(reloaded.formatCostSection()).toContain('Direct Mode & Council Telemetry');
      db.close();
    });
  });

  describe('Wave F: Deterministic Parallel Wave 2 TaskGraph Compiler', () => {
    it('compiles Wave 2 modules directly into disjoint parallel TaskGraph nodes without needing an LLM', () => {
      const plan = buildDeterministicLivingPlan(
        'Build a CLI tool in Rust with parser, planner, and renderer',
      );
      const wave2 = plan.waves[1];
      const graph = compileWaveToTaskGraph(plan, wave2, 'goal-1');
      expect(graph).toBeDefined();
      const tasks = graph!.getAllTasks();
      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.id)).toEqual(['TASK-01', 'TASK-02', 'TASK-03']);
      // All 3 tasks have zero dependencies -> true parallel Wave 2 fan-out!
      expect(tasks.every((t) => t.dependencies.length === 0)).toBe(true);
      // Disjoint scopes
      expect(tasks[0].contract.allowedScope).toEqual(['src/parser/**', 'tests/parser/**']);
      expect(tasks[1].contract.allowedScope).toEqual(['src/planner/**', 'tests/planner/**']);
      expect(tasks[2].contract.allowedScope).toEqual(['src/renderer/**', 'tests/renderer/**']);
    });
  });

  describe('Wave G: Durable Project Memory (.taskforge/memory.md), /compact & Interactive Council Follow-Up', () => {
    it('persists durable project memory, captures natural language, and compacts long direct sessions', () => {
      const repoRoot = createTempRepo();
      tempDirs.push(repoRoot);

      expect(parseNaturalMemoryCapture('lembra que nesse projeto usamos Vitest e não Jest')).toEqual({
        text: 'nesse projeto usamos Vitest e não Jest',
        language: 'pt',
      });
      expect(parseNaturalMemoryCapture('remember that all API responses use camelCase')).toEqual({
        text: 'all API responses use camelCase',
        language: 'en',
      });

      addProjectMemoryEntry(repoRoot, 'Always use Vitest, never Jest', 'convention');
      addProjectMemoryEntry(repoRoot, 'Always use Vitest, never Jest', 'convention'); // deduplicated
      expect(loadProjectMemory(repoRoot)).toHaveLength(1);
      expect(formatProjectMemoryForPrompt(repoRoot)).toContain('Always use Vitest, never Jest');

      const mem = new DirectConversationMemory(24);
      for (let i = 1; i <= 14; i++) {
        mem.record({ kind: 'user', text: `question ${i}`, timestamp: new Date().toISOString() });
      }
      const res = mem.compact(4);
      expect(res.compactedCount).toBe(10);
      expect(res.remainingCount).toBe(5); // 1 summary + 4 recent
      expect(mem.formatForPrompt()).toContain('Compacted Session Summary');
    });

    it('runs an interactive Council follow-up round (Round 4) and updates the verdict', async () => {
      const repoRoot = createTempRepo();
      tempDirs.push(repoRoot);

      const codex = new EvolutionStubAdapter('codex', 'Codex CLI', async (a) => ({
        success: true,
        message: a.taskId.startsWith('FOLLOWUP') ? 'Use advisory locks with 5s timeout.' : 'Use Postgres queue.',
        output: a.taskId.startsWith('FOLLOWUP') ? 'Use advisory locks with 5s timeout.' : 'Use Postgres queue.',
        durationMs: 25,
      }));
      const agy = new EvolutionStubAdapter('agy', 'Google Antigravity', async (a) => ({
        success: true,
        message: a.taskId.startsWith('FOLLOWUP') ? 'Combine SKIP LOCKED with heartbeat lease.' : 'Use Redis streams.',
        output: a.taskId.startsWith('FOLLOWUP') ? 'Combine SKIP LOCKED with heartbeat lease.' : 'Use Redis streams.',
        durationMs: 25,
      }));
      const registry = new AgentRegistry(false);
      registry.register(codex);
      registry.register(agy);

      const council = new DebateCouncilRunner({ repoRoot, agentRegistry: registry });
      const { pending } = await council.runCouncil(['codex', 'agy'], 'Fila resiliente?');
      expect(pending).toBeDefined();

      const followUp = await council.runFollowUpRound(pending!, 'como evitar deadlocks sob carga?');
      expect(followUp.formatted).toContain('Council Follow-Up Round');
      expect(followUp.formatted).toContain('SKIP LOCKED with heartbeat lease');
      expect(followUp.updatedDecision.refinements[0].content).toContain('advisory locks');
    });
  });

  describe('Wave H: GitHub Autopilot Parsing & Adversarial Multi-Agent TDD (/tdd)', () => {
    it('parses /fix-ci, /review-pr, /issue and PT/EN natural-language equivalents', () => {
      expect(parseGitHubAutopilotCommand('/fix-ci')).toEqual({ kind: 'fix_ci', runId: undefined, language: 'en' });
      expect(parseGitHubAutopilotCommand('corrige o CI desse PR')).toEqual({ kind: 'fix_ci', language: 'pt' });
      expect(parseGitHubAutopilotCommand('/review-pr #128')).toEqual({
        kind: 'review_pr',
        prNumber: '128',
        targets: 'all',
        language: 'en',
      });
      expect(parseGitHubAutopilotCommand('revisa o PR #42')).toEqual({
        kind: 'review_pr',
        prNumber: '42',
        targets: 'all',
        language: 'pt',
      });
      expect(parseGitHubAutopilotCommand('resolve a issue #77')).toEqual({
        kind: 'issue',
        issueNumber: '77',
        language: 'pt',
      });
    });

    it('executes Adversarial TDD loop (Agent A writes failing test -> Agent B implements until test passes)', async () => {
      const repoRoot = createTempRepo();
      tempDirs.push(repoRoot);

      const agy = new EvolutionStubAdapter('agy', 'Google Antigravity', async (_a, ctx) => {
        fs.writeFileSync(
          path.join(ctx.worktreePath, 'check.mjs'),
          "import fs from 'node:fs';\nconst code = fs.readFileSync('math.js', 'utf8');\nif (!code.includes('return a * b')) process.exit(1);\n",
          'utf8',
        );
        fs.writeFileSync(path.join(ctx.worktreePath, 'math.js'), 'export const mul = () => 0;\n', 'utf8');
        return { success: true, message: 'Wrote failing test check.mjs', output: 'Wrote failing test check.mjs', durationMs: 30 };
      });
      const codex = new EvolutionStubAdapter('codex', 'Codex CLI', async (_a, ctx) => {
        fs.writeFileSync(
          path.join(ctx.worktreePath, 'math.js'),
          'export function mul(a, b) { return a * b; }\n',
          'utf8',
        );
        return { success: true, message: 'Implemented mul(a, b)', output: 'Implemented mul(a, b)', durationMs: 30 };
      });

      const registry = new AgentRegistry(false);
      registry.register(agy);
      registry.register(codex);

      const runner = new DirectAgentRunner({
        repoRoot,
        agentRegistry: registry,
        memory: new DirectConversationMemory(),
        verificationCommands: ['node check.mjs'],
      });

      const tdd = await runner.runAdversarialTdd('agy', 'codex', 'multiply two numbers');
      expect(tdd.passed).toBe(true);
      expect(tdd.formatted).toContain('GREEN — tests passing');
      expect(tdd.filesChanged).toContain('math.js');
    });
  });

  describe('Wave I: Project Skills, Lifecycle Hooks, Background Jobs & Specialty Routing', () => {
    it('discovers skills across .taskforge/skills and .claude/commands and expands arguments', () => {
      const repoRoot = createTempRepo();
      tempDirs.push(repoRoot);

      fs.mkdirSync(path.join(repoRoot, '.taskforge', 'skills'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.taskforge', 'skills', 'sec-audit.md'),
        '---\ndescription: Run security review\n---\nAudit $ARGUMENTS for injection and auth flaws.\n',
        'utf8',
      );
      fs.mkdirSync(path.join(repoRoot, '.claude', 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.claude', 'commands', 'release-notes.md'),
        '# Release Notes\nSummarize recent commits for {{args}}.\n',
        'utf8',
      );

      const skills = discoverProjectSkills(repoRoot);
      expect(skills.map((s) => s.name)).toEqual(['release-notes', 'sec-audit']);
      expect(expandSkillPrompt(skills[1], 'packages/auth')).toContain('Audit packages/auth for injection');
    });

    it('runs afterDirectEdit lifecycle hooks, background REPL jobs, and specialty-aware routing end-to-end', async () => {
      const repoRoot = createTempRepo();
      tempDirs.push(repoRoot);
      const db = new TaskForgeDatabase(':memory:');
      const config = getDefaultConfig();
      const hookMarker = path.join(repoRoot, '.hook-ran.txt');
      config.hooks = { afterDirectEdit: `echo "$TASKFORGE_CHANGED_FILES" > "${hookMarker}"`, timeoutSeconds: 10 };

      // 1. Lifecycle hook test
      const hookRunner = new LifecycleHookRunner(repoRoot, () => config);
      const hookRes = await hookRunner.runHook('afterDirectEdit', { TASKFORGE_CHANGED_FILES: 'index.ts' });
      expect(hookRes.ran).toBe(true);
      expect(hookRes.exitCode).toBe(0);
      expect(fs.readFileSync(hookMarker, 'utf8').trim()).toBe('index.ts');

      // 2. SpecialtyRouter learns per-domain leader from telemetry
      const telemetry = new DirectTelemetryStore(db);
      for (let i = 0; i < 3; i++) {
        telemetry.record({
          agentId: 'agy',
          agentName: 'Google Antigravity',
          category: 'direct',
          prompt: 'refactor react component ui',
          files: ['App.tsx'],
          success: true,
          durationMs: 2000,
          tokensUsed: 500,
        });
      }
      const specialty = new SpecialtyRouter(db, telemetry, 3);
      const rec = specialty.recommendForTask('update Button.tsx react ui', ['codex', 'agy'], ['Button.tsx']);
      expect(rec?.agentId).toBe('agy');
      expect(rec?.specialty).toBe('frontend');

      // 3. BackgroundJobManager runs async tasks without blocking
      const finished: string[] = [];
      const bg = new BackgroundJobManager((j) => finished.push(j.id));
      const job = bg.start('test job', async () => 'job result ok');
      expect(job.id).toBe('bg-1');
      await new Promise((r) => setTimeout(r, 40));
      expect(finished).toEqual(['bg-1']);
      expect(bg.formatJobOutput('bg-1')).toContain('job result ok');

      // 4. InteractiveShell end-to-end: /memory, /compact, /skills, /bg, /stats, dynamic prompt badge
      const shell = new InteractiveShell({
        repoRoot,
        config,
        database: db,
        output: new PassThrough(),
        interactive: false,
      });

      const memOut = await shell.handleInput('lembra que sempre usamos pnpm neste repositório');
      expect(memOut).toContain('.taskforge/memory.md');
      expect(await shell.handleInput('/memory')).toContain('sempre usamos pnpm');

      await shell.handleInput('/use codex');
      expect(shell.viewport.getModeBadge()).toContain('@codex');

      const bgStartOut = await shell.handleInput('& /memory');
      // eslint-disable-next-line no-control-regex
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripAnsi(bgStartOut)).toContain('Started background job bg-1');
      await new Promise((r) => setTimeout(r, 40));
      expect(await shell.handleInput('/bg bg-1')).toContain('sempre usamos pnpm');

      db.close();
    });
  });
});
