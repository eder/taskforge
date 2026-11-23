import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TaskForgeDatabase } from '@taskforge/persistence';
import type { AgentAdapter } from '@taskforge/agents';
import type { AgentAssignment, AgentCapabilities, AgentContext, AgentResult } from '@taskforge/shared';
import {
  parseDirectRouteCommand,
  extractOrchestratedAgentPreferences,
} from '../src/direct-agent-router.js';
import { DirectConversationMemory } from '../src/direct-agent-session.js';
import { InteractiveShell } from '../src/interactive-shell.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (s: string) => s.replace(ANSI, '');

class StubDirectAgent implements AgentAdapter {
  public calls: Array<{ assignment: AgentAssignment; context: AgentContext }> = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly responder: (ctx: AgentContext) => AgentResult,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript', 'Python'],
      tools: ['bash', 'file_editor', 'git'],
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls.push({ assignment, context });
    context.onStreamEvent?.({
      type: 'file_read',
      path: 'README.md',
      runId: '',
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      agentId: this.id,
      role: assignment.role,
      timestamp: new Date(),
    });
    return this.responder(context);
  }
}

describe('parseDirectRouteCommand & extractOrchestratedAgentPreferences', () => {
  it('parses !shell, /use, bare @agent sticky switches, and inline @agent/@all invocations', () => {
    expect(parseDirectRouteCommand('!git status')).toEqual({
      kind: 'shell',
      command: 'git status',
    });
    expect(parseDirectRouteCommand('/use claude')).toEqual({
      kind: 'switch_mode',
      mode: 'claude',
    });
    expect(parseDirectRouteCommand('/use all')).toEqual({
      kind: 'switch_mode',
      mode: 'all',
    });
    expect(parseDirectRouteCommand('/use auto')).toEqual({
      kind: 'switch_mode',
      mode: 'auto',
    });
    expect(parseDirectRouteCommand('@codex')).toEqual({
      kind: 'switch_mode',
      mode: 'codex',
    });
    expect(parseDirectRouteCommand('@auto')).toEqual({
      kind: 'switch_mode',
      mode: 'auto',
    });
    expect(parseDirectRouteCommand('@claude explica o router')).toEqual({
      kind: 'direct_agents',
      targets: ['claude'],
      prompt: 'explica o router',
    });
    expect(parseDirectRouteCommand('@claude @codex comparem SQLite vs Postgres')).toEqual({
      kind: 'direct_agents',
      targets: ['claude', 'codex'],
      prompt: 'comparem SQLite vs Postgres',
    });
    expect(parseDirectRouteCommand('@all revisem server/app.py')).toEqual({
      kind: 'direct_agents',
      targets: 'all',
      prompt: 'revisem server/app.py',
    });
    expect(parseDirectRouteCommand('@antigravity: explica o erro')).toEqual({
      kind: 'direct_agents',
      targets: ['agy'],
      prompt: 'explica o erro',
    });
  });

  it('ignores non-agent @ tokens such as file paths or decorators', () => {
    expect(parseDirectRouteCommand('@dataclass class Foo: pass')).toEqual({ kind: 'none' });
    expect(parseDirectRouteCommand('@src/index.ts fix bug')).toEqual({ kind: 'none' });
    expect(parseDirectRouteCommand('implement password reset')).toEqual({ kind: 'none' });
  });

  it('extracts natural-language agent role preferences for orchestrated goals (PT & EN)', () => {
    expect(
      extractOrchestratedAgentPreferences('pede pro claude implementar e pro codex revisar o cache'),
    ).toEqual({
      implementer: 'claude',
      reviewer: 'codex',
    });
    expect(
      extractOrchestratedAgentPreferences('use codex to implement and antigravity to review auth'),
    ).toEqual({
      implementer: 'codex',
      reviewer: 'agy',
    });
    expect(extractOrchestratedAgentPreferences('usa o claude para melhorar os logs')).toEqual({
      defaultAgent: 'claude',
    });
  });
});

describe('DirectConversationMemory & InteractiveShell direct multi-agent parity', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-direct-ui-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'],
      { cwd: dir },
    );
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function openWithStubAgents() {
    const claude = new StubDirectAgent('claude', 'Claude Code', (ctx) => ({
      success: true,
      output: `Claude reply (${ctx.mutationAllowed ? 'write' : 'ro'}): ${ctx.originalUserRequest}`,
      durationMs: 25,
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, modelName: 'claude' },
    }));
    const codex = new StubDirectAgent('codex', 'Codex CLI', (ctx) => {
      if (ctx.mutationAllowed) {
        fs.writeFileSync(path.join(dir, 'README.md'), '# demo updated by codex\n');
      }
      return {
        success: true,
        output: `Codex reply (${ctx.mutationAllowed ? 'write' : 'ro'}): ${ctx.originalUserRequest}`,
        durationMs: 30,
        usage: { inputTokens: 60, outputTokens: 30, totalTokens: 90, modelName: 'codex' },
      };
    });

    shell = new InteractiveShell({ repoRoot: dir, database: db });
    const registry = (shell as unknown as { agentRegistry: { register: (a: AgentAdapter) => void } })
      .agentRegistry;
    registry.register(claude);
    registry.register(codex);
    return { shell, claude, codex };
  }

  it('runs @claude, @codex, @claude @codex, and !shell with shared cross-agent memory and zero Plan ceremony', async () => {
    const { shell: s, claude, codex } = openWithStubAgents();

    // 1. Direct read-only turn to Claude
    const r1 = plain(await s.handleInput('@claude explica como o projeto funciona'));
    expect(r1).toContain('Claude Code');
    expect(r1).not.toContain('Plan Proposal');
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0].context.directMode).toBe(true);
    expect(claude.calls[0].context.mutationAllowed).toBe(false);

    // 2. Direct shell escape captured into shared memory
    const sh = plain(await s.handleInput('!echo direct-shell-ok'));
    expect(sh).toContain('exit 0');
    expect(sh).toContain('direct-shell-ok');

    // 3. Direct write turn to Codex — automatically receives Claude's reply + !shell output!
    const r2 = plain(await s.handleInput('@codex atualiza o README.md com o resultado'));
    expect(r2).toContain('Codex CLI');
    expect(r2).toContain('Modified files: README.md');
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0].context.directMode).toBe(true);
    expect(codex.calls[0].context.mutationAllowed).toBe(true);
    expect(codex.calls[0].context.conversationHistory).toContain('Claude reply');
    expect(codex.calls[0].context.conversationHistory).toContain('direct-shell-ok');

    // 4. Parallel multi-agent consultation (@claude @codex) runs read-only safely
    const r3 = plain(await s.handleInput('@claude @codex comparem as abordagens e sugiram melhorias'));
    expect(r3).toContain('Claude Code');
    expect(r3).toContain('Codex CLI');
    expect(claude.calls).toHaveLength(2);
    expect(codex.calls).toHaveLength(2);
    expect(claude.calls[1].context.mutationAllowed).toBe(false);
    expect(codex.calls[1].context.mutationAllowed).toBe(false);

    // 5. Sticky mode (`@claude` -> plain message -> `/use auto`) and `/clear` wipes memory
    const pinned = plain(await s.handleInput('@claude'));
    expect(pinned).toContain('Direct mode pinned to Claude Code');
    const r4 = plain(await s.handleInput('o que o codex acabou de alterar?'));
    expect(r4).toContain('Claude Code');
    expect(claude.calls[2].context.conversationHistory).toContain('Codex reply');

    await s.handleInput('/clear');
    const r5 = plain(await s.handleInput('qual o status agora?'));
    expect(r5).toContain('Claude Code');
    expect(claude.calls[3].context.conversationHistory).toBeUndefined();

    const backToAuto = plain(await s.handleInput('/use auto'));
    expect(backToAuto).toContain('Hybrid Smart (auto)');
  });

  it('honors natural-language agent role preferences on orchestrated plans', async () => {
    const { shell: s } = openWithStubAgents();
    const reply = plain(
      await s.handleInput('pede pro claude implementar e pro codex revisar a autenticação do servidor'),
    );
    expect(reply).toContain('Plan Proposal');
    expect(reply).toContain('Claude Code');

    const graph = (
      s as unknown as {
        currentGraph?: { getAllTasks: () => Array<{ type: string; contract: { metadata?: Record<string, unknown> } }> };
      }
    ).currentGraph;
    const tasks = graph?.getAllTasks() ?? [];
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const impl = tasks.find((t) => t.type !== 'review');
    const rev = tasks.find((t) => t.type === 'review');
    expect(impl?.contract.metadata?.preferredAgent).toBe('claude');
    expect(rev?.contract.metadata?.preferredAgent).toBe('codex');
  });

  it('bounds DirectConversationMemory prompt formatting', () => {
    const mem = new DirectConversationMemory(4);
    for (let i = 0; i < 6; i++) {
      mem.record({ kind: 'user', text: `msg-${i}`, timestamp: new Date().toISOString() });
    }
    expect(mem.getEntries()).toHaveLength(4);
    expect(mem.formatForPrompt()).not.toContain('msg-0');
    expect(mem.formatForPrompt()).toContain('msg-5');
  });
});
