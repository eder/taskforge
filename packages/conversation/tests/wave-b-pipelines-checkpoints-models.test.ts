import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import {
  AgentRegistry,
  ClaudeCodeAdapter,
  CodexAdapter,
  AntigravityAdapter,
  type AgentAdapter,
} from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { getDefaultConfig, loadConfig, type AgentAssignment, type AgentContext, type AgentResult } from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';
import {
  parseDirectRouteCommand,
  parseNaturalConfigChange,
  parseDirectGitIntent,
  DirectCheckpointManager,
  DirectConversationMemory,
  DirectAgentRunner,
  InteractiveShell,
} from '../src/index.js';

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wave-b-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

class StubAgentAdapter implements AgentAdapter {
  public calls: Array<{ prompt: string; mutationAllowed?: boolean; role: string }> = [];
  public modelConfig: { model?: string; effort?: string } = {};

  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly handler: (assignment: AgentAssignment, context: AgentContext) => Promise<AgentResult>,
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

  getModelConfig(): { model?: string; effort?: string } {
    return { ...this.modelConfig };
  }

  setModelConfig(cfg: { model?: string; effort?: string }): void {
    if ('model' in cfg) this.modelConfig.model = cfg.model;
    if ('effort' in cfg) this.modelConfig.effort = cfg.effort;
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls.push({
      prompt: assignment.objective,
      mutationAllowed: context.mutationAllowed,
      role: assignment.role,
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

describe('Wave B: Direct Pipelines, Checkpoints/Undo, Per-Agent Model Picker & Direct Git/PR', () => {
  describe('Router & Natural-Language Parsing', () => {
    it('parses @a -> @b pipelines, multi-stage chains, and @a <-> @b debates', () => {
      expect(parseDirectRouteCommand('@codex -> @agy corrige o bug em app.ts')).toEqual({
        kind: 'direct_pipeline',
        stages: ['codex', 'agy'],
        prompt: 'corrige o bug em app.ts',
      });

      expect(parseDirectRouteCommand('@smart => @agy => @claude refatora auth')).toEqual({
        kind: 'direct_pipeline',
        stages: ['smart', 'agy', 'claude'],
        prompt: 'refatora auth',
      });

      expect(parseDirectRouteCommand('@codex <-> @agy qual fila usar: Redis ou Postgres?')).toEqual({
        kind: 'direct_debate',
        targets: ['codex', 'agy'],
        prompt: 'qual fila usar: Redis ou Postgres?',
      });

      expect(parseDirectRouteCommand('@all <-> monolito modular ou microserviços?')).toEqual({
        kind: 'direct_debate',
        targets: 'all',
        prompt: 'monolito modular ou microserviços?',
      });
    });

    it('parses /model commands cleanly (show, set, effort, reset, validation)', () => {
      expect(parseDirectRouteCommand('/model')).toEqual({ kind: 'model_config', action: 'show' });
      expect(parseDirectRouteCommand('/model codex o3')).toEqual({
        kind: 'model_config',
        action: 'set',
        agentId: 'codex',
        model: 'o3',
      });
      expect(parseDirectRouteCommand('/model antigravity gemini-2.5-pro high')).toEqual({
        kind: 'model_config',
        action: 'set',
        agentId: 'agy',
        model: 'gemini-2.5-pro',
        effort: 'high',
      });
      expect(parseDirectRouteCommand('/model claude effort medium')).toEqual({
        kind: 'model_config',
        action: 'set',
        agentId: 'claude',
        effort: 'medium',
      });
      expect(parseDirectRouteCommand('/model codex reset')).toEqual({
        kind: 'model_config',
        action: 'reset',
        agentId: 'codex',
      });
      const badEffort = parseDirectRouteCommand('/model codex o3 ultra');
      expect(badEffort.kind).toBe('model_config');
      if (badEffort.kind === 'model_config') expect(badEffort.error).toContain('Unknown effort');
    });

    it('parses natural-language model and effort configuration updates (PT & EN)', () => {
      const ptModel = parseNaturalConfigChange('usa o modelo o3 no codex');
      expect(ptModel?.language).toBe('pt');
      expect(ptModel?.updates).toEqual([
        { keyPath: ['agents', 'codex', 'model'], value: 'o3', label: 'agents.codex.model = o3', action: 'set' },
      ]);

      const ptSwap = parseNaturalConfigChange('troca o modelo do agy para gemini-2.5-pro');
      expect(ptSwap?.updates[0]).toMatchObject({
        keyPath: ['agents', 'agy', 'model'],
        value: 'gemini-2.5-pro',
      });

      const enEffort = parseNaturalConfigChange('set codex effort to high');
      expect(enEffort?.updates[0]).toMatchObject({
        keyPath: ['agents', 'codex', 'effort'],
        value: 'high',
      });

      const ptReset = parseNaturalConfigChange('reseta o modelo do codex');
      expect(ptReset?.updates).toHaveLength(2);
      expect(ptReset?.updates[0]).toMatchObject({
        keyPath: ['agents', 'codex', 'model'],
        action: 'delete',
      });

      // Engineering tasks mentioning "model" must NOT trigger config changes
      expect(parseNaturalConfigChange('corrigir o bug no modelo User em model.ts')).toBeUndefined();
    });

    it('parses conversational direct git & undo intents without false positives', () => {
      expect(parseDirectGitIntent('desfaz')).toEqual({ kind: 'undo', language: 'pt' });
      expect(parseDirectGitIntent('desfaz a última alteração')).toEqual({ kind: 'undo', language: 'pt' });
      expect(parseDirectGitIntent('undo last edit')).toEqual({ kind: 'undo', language: 'en' });
      expect(parseDirectGitIntent('mostra o diff')).toEqual({ kind: 'diff', language: 'pt' });
      expect(parseDirectGitIntent('o que mudou?')).toEqual({ kind: 'diff', language: 'pt' });
      expect(parseDirectGitIntent('git status')).toEqual({ kind: 'status', language: 'en' });
      expect(parseDirectGitIntent('faz commit disso')).toEqual({ kind: 'commit', language: 'pt' });
      expect(parseDirectGitIntent('faz commit com mensagem "fix: typo"')).toEqual({
        kind: 'commit',
        message: 'fix: typo',
        language: 'pt',
      });
      expect(parseDirectGitIntent('abre um pr')).toEqual({ kind: 'pr', language: 'pt' });
      expect(parseDirectGitIntent('open a pr titled "feat: wave b"')).toEqual({
        kind: 'pr',
        title: 'feat: wave b',
        language: 'en',
      });

      // Must NOT match actual code tasks
      expect(parseDirectGitIntent('corrige o bug no git-service.ts')).toBeUndefined();
      expect(parseDirectGitIntent('implementa o endpoint de status')).toBeUndefined();
    });
  });

  describe('Per-Agent Adapter Model & Effort CLI Flags', () => {
    const dummyCtx: AgentContext = {
      worktreePath: '/tmp',
      originalUserRequest: 'hello',
      mutationAllowed: false,
      assignment: {
        id: 'a1',
        taskId: 'T1',
        agentId: 'codex',
        role: 'researcher',
        objective: 'hello',
        status: 'running',
      },
      task: {
        objective: 'hello',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: [],
        dependencies: [],
      },
    };

    it('injects --model / -c model and effort flags dynamically for Codex, Claude, and AGY', () => {
      const codex = new CodexAdapter({ model: 'o3', effort: 'high' });
      const codexFresh = (codex as unknown as { formatArgs: (p: string, c?: AgentContext) => string[] }).formatArgs(
        'hi',
        dummyCtx,
      );
      expect(codexFresh).toContain('--model');
      expect(codexFresh).toContain('o3');
      expect(codexFresh).toContain('model_reasoning_effort="high"');

      const codexResume = (codex as unknown as { formatArgs: (p: string, c?: AgentContext) => string[] }).formatArgs(
        'follow-up',
        { ...dummyCtx, providerSessionId: 'thread-123' },
      );
      expect(codexResume).toContain('resume');
      expect(codexResume).toContain('model="o3"');
      expect(codexResume).toContain('model_reasoning_effort="high"');

      codex.setModelConfig({ model: 'gpt-5.3-codex', effort: undefined });
      const codexUpdated = (codex as unknown as { formatArgs: (p: string, c?: AgentContext) => string[] }).formatArgs(
        'hi',
        dummyCtx,
      );
      expect(codexUpdated).toContain('gpt-5.3-codex');
      expect(codexUpdated).not.toContain('model_reasoning_effort="high"');

      const claude = new ClaudeCodeAdapter({ model: 'claude-sonnet-4-6', effort: 'medium' });
      const claudeArgs = (claude as unknown as { formatArgs: (p: string, c?: AgentContext) => string[] }).formatArgs(
        'hi',
        dummyCtx,
      );
      expect(claudeArgs).toContain('--model');
      expect(claudeArgs).toContain('claude-sonnet-4-6');
      expect(claudeArgs).toContain('--effort');
      expect(claudeArgs).toContain('medium');
      expect(claudeArgs.indexOf('--model')).toBeLessThan(claudeArgs.indexOf('-p'));

      const agy = new AntigravityAdapter({ model: 'gemini-2.5-pro', effort: 'xhigh' });
      const agyArgs = (agy as unknown as { formatArgs: (p: string, c?: AgentContext) => string[] }).formatArgs(
        'hi',
        { ...dummyCtx, providerSessionId: 'conv-42' },
      );
      expect(agyArgs).toContain('--conversation');
      expect(agyArgs).toContain('conv-42');
      expect(agyArgs).toContain('--model');
      expect(agyArgs).toContain('gemini-2.5-pro');
      expect(agyArgs).toContain('--effort');
      expect(agyArgs).toContain('xhigh');
      expect(agyArgs.indexOf('--model')).toBeLessThan(agyArgs.indexOf('-p'));
    });
  });

  describe('DirectCheckpointManager (/undo)', () => {
    it('snapshots and restores tracked edits, untracked files, and removes newly created files without using git stash', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);
      const mgr = new DirectCheckpointManager(repoRoot);

      // Pre-existing dirty state: modified tracked file + untracked file
      fs.writeFileSync(path.join(repoRoot, 'app.ts'), 'export const version = 2;\n', 'utf8');
      fs.writeFileSync(path.join(repoRoot, 'notes.txt'), 'keep me\n', 'utf8');

      const cp = await mgr.capture('edit app.ts', 'codex');
      expect(cp).toBeDefined();

      // Simulate agent editing app.ts, deleting notes.txt, and creating stray.ts
      fs.writeFileSync(path.join(repoRoot, 'app.ts'), 'export const version = 999;\n', 'utf8');
      fs.unlinkSync(path.join(repoRoot, 'notes.txt'));
      fs.writeFileSync(path.join(repoRoot, 'stray.ts'), 'export const bad = true;\n', 'utf8');

      // Verify git stash list was never touched
      const stashList = execFileSync('git', ['stash', 'list'], { cwd: repoRoot, encoding: 'utf8' }).trim();
      expect(stashList).toBe('');

      const restored = await mgr.restoreLatest();
      expect(restored.success).toBe(true);
      expect(restored.removedFiles).toContain('stray.ts');
      expect(fs.readFileSync(path.join(repoRoot, 'app.ts'), 'utf8')).toBe('export const version = 2;\n');
      expect(fs.readFileSync(path.join(repoRoot, 'notes.txt'), 'utf8')).toBe('keep me\n');
      expect(fs.existsSync(path.join(repoRoot, 'stray.ts'))).toBe(false);
    });

    it('refuses destructive restore if HEAD moved after a commit', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);
      const mgr = new DirectCheckpointManager(repoRoot);

      const cp = await mgr.capture('before commit', 'codex');
      expect(cp).toBeDefined();

      fs.writeFileSync(path.join(repoRoot, 'app.ts'), 'export const version = 3;\n', 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'user commit'], { cwd: repoRoot, stdio: 'ignore' });

      const res = await mgr.restoreLatest();
      expect(res.success).toBe(false);
      expect(res.error).toContain('HEAD moved');
    });
  });

  describe('Expressive Direct Pipelines (@a -> @b) & Structured Debate (@a <-> @b)', () => {
    it('pipes Stage 1 diff into Stage 2 read-only reviewer and offers 1-Enter fix follow-up', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);

      const codex = new StubAgentAdapter('codex', 'Codex CLI', async (_a, ctx) => {
        fs.writeFileSync(
          path.join(ctx.worktreePath, 'app.ts'),
          'export const version = 2;\nexport const bug = null as any;\n',
          'utf8',
        );
        return { success: true, message: 'Updated app.ts to v2', output: 'Updated app.ts to v2', durationMs: 120 };
      });
      const agy = new StubAgentAdapter('agy', 'Google Antigravity', async (assignment, ctx) => {
        if (ctx.mutationAllowed) {
          fs.writeFileSync(path.join(ctx.worktreePath, 'app.ts'), 'export const version = 2;\n', 'utf8');
          return { success: true, message: 'Removed unsafe any cast', output: 'Removed unsafe any cast', durationMs: 80 };
        }
        return {
          success: true,
          message: 'Found issue: remove `null as any` in app.ts',
          output: 'Found issue: remove `null as any` in app.ts',
          durationMs: 90,
        };
      });

      const registry = new AgentRegistry(false);
      registry.register(codex);
      registry.register(agy);

      const checkpoints = new DirectCheckpointManager(repoRoot);
      const runner = new DirectAgentRunner({
        repoRoot,
        agentRegistry: registry,
        memory: new DirectConversationMemory(),
        checkpointManager: checkpoints,
      });

      const res = await runner.runPipeline(['codex', 'agy'], 'atualiza a versão em app.ts para 2');
      expect(res.outcomes).toHaveLength(2);
      expect(codex.calls[0].mutationAllowed).toBe(true);
      expect(agy.calls[0].mutationAllowed).toBe(false);
      // Stage 2 reviewer received the exact unified diff from Stage 1!
      expect(agy.calls[0].prompt).toContain('export const bug = null as any');
      expect(res.pendingFollowUp).toBeDefined();
      expect(res.pendingFollowUp?.reviewerId).toBe('agy');
      expect(checkpoints.list()).toHaveLength(1);

      // Apply reviewer fix follow-up
      await runner.applyPipelineFollowUp(res.pendingFollowUp!, res.pendingFollowUp!.reviewerId);
      expect(fs.readFileSync(path.join(repoRoot, 'app.ts'), 'utf8')).toBe('export const version = 2;\n');
      expect(checkpoints.list()).toHaveLength(2);

      // Undo step 1 -> back to Stage 1 output; Undo step 2 -> back to clean v1!
      await checkpoints.restoreLatest();
      expect(fs.readFileSync(path.join(repoRoot, 'app.ts'), 'utf8')).toContain('null as any');
      await checkpoints.restoreLatest();
      expect(fs.readFileSync(path.join(repoRoot, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');
    });

    it('runs a 2-round structured direct debate (@codex <-> @agy) with cross-critique and verdict', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);

      const codex = new StubAgentAdapter('codex', 'Codex CLI', async (a) => ({
        success: true,
        message: a.taskId === 'DEBATE-R1' ? 'Use SQLite for zero-ops local speed.' : 'Acknowledging Postgres scaling, SQLite with WAL still wins locally.',
        output: a.taskId === 'DEBATE-R1' ? 'Use SQLite for zero-ops local speed.' : 'Acknowledging Postgres scaling, SQLite with WAL still wins locally.',
        durationMs: 50,
      }));
      const agy = new StubAgentAdapter('agy', 'Google Antigravity', async (a) => ({
        success: true,
        message: a.taskId === 'DEBATE-R1' ? 'Use Postgres for multi-writer concurrency.' : 'Agree with Codex for single-node CLI; use SQLite locally, Postgres for hosted.',
        output: a.taskId === 'DEBATE-R1' ? 'Use Postgres for multi-writer concurrency.' : 'Agree with Codex for single-node CLI; use SQLite locally, Postgres for hosted.',
        durationMs: 60,
      }));

      const registry = new AgentRegistry(false);
      registry.register(codex);
      registry.register(agy);

      const runner = new DirectAgentRunner({
        repoRoot,
        agentRegistry: registry,
        memory: new DirectConversationMemory(),
        consensusSynthesizer: async () => 'Verdict: SQLite with WAL for local CLI, Postgres for multi-node hosted.',
      });

      const debate = await runner.runDebate(['codex', 'agy'], 'SQLite ou Postgres?');
      expect(debate.round1).toHaveLength(2);
      expect(debate.round2).toHaveLength(2);
      expect(codex.calls).toHaveLength(2);
      expect(agy.calls).toHaveLength(2);
      // Round 2 prompts contain the peer's Round 1 position!
      expect(codex.calls[1].prompt).toContain('Use Postgres for multi-writer concurrency');
      expect(agy.calls[1].prompt).toContain('Use SQLite for zero-ops local speed');
      expect(debate.formatted).toContain('Round 1 — Independent Positions');
      expect(debate.formatted).toContain('Round 2 — Cross-Critique & Refinement');
      expect(debate.formatted).toContain('Debate Verdict');
      expect(debate.formatted).toContain('SQLite with WAL');
    });
  });

  describe('InteractiveShell End-to-End Integration (/model, /undo, diff, commit)', () => {
    it('persists /model overrides to .taskforge/config.yaml and handles direct diff, undo, and 1-Enter commit', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);
      const db = new TaskForgeDatabase(':memory:');
      const out = new PassThrough();
      const shell = new InteractiveShell({
        repoRoot,
        config: getDefaultConfig(),
        database: db,
        output: out,
        interactive: false,
      });

      // 1. Set per-agent model & effort via /model and verify persistence + reset
      const setOut = await shell.handleInput('/model codex o3 high');
      expect(setOut).toContain('o3');
      expect(setOut).toContain('high');
      const reloaded = loadConfig(path.join(repoRoot, '.taskforge', 'config.yaml'));
      expect(reloaded.agents.codex?.model).toBe('o3');
      expect(reloaded.agents.codex?.effort).toBe('high');

      const showOut = await shell.handleInput('/model codex');
      expect(showOut).toContain('o3');
      expect(showOut).toContain('high');

      const resetOut = await shell.handleInput('/model codex reset');
      expect(resetOut).toContain('Reset');
      const reloadedAfterReset = loadConfig(path.join(repoRoot, '.taskforge', 'config.yaml'));
      expect(reloadedAfterReset.agents.codex?.model).toBeUndefined();
      expect(reloadedAfterReset.agents.codex?.effort).toBeUndefined();

      // 2. Natural-language model config update
      const nlOut = await shell.handleInput('usa o modelo gemini-2.5-pro no agy');
      expect(nlOut).toContain('agents.agy.model = gemini-2.5-pro');
      expect(loadConfig(path.join(repoRoot, '.taskforge', 'config.yaml')).agents.agy?.model).toBe(
        'gemini-2.5-pro',
      );

      // 3. Direct working-tree diff + 1-Enter commit
      fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Demo\nUpdated via Wave B\n', 'utf8');
      const diffOut = await shell.handleInput('mostra o diff');
      expect(diffOut).toContain('Working Tree Diff');
      expect(diffOut).toContain('Updated via Wave B');

      const commitPrompt = await shell.handleInput('faz commit com mensagem "docs: update readme"');
      expect(commitPrompt).toContain('Confirmar commit direto');
      expect(commitPrompt).toContain('docs: update readme');

      // Press Enter to confirm commit
      const commitDone = await shell.handleInput('');
      expect(commitDone).toContain('Commit criado');
      const git = new GitService(repoRoot);
      const lastMsg = (await git.exec(['log', '-1', '--pretty=%s'], repoRoot)).trim();
      expect(lastMsg).toBe('docs: update readme');

      db.close();
    });
  });
});
