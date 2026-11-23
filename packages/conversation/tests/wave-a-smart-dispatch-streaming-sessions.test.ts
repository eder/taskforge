import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  getDefaultConfig,
  type AgentAssignment,
  type AgentCapabilities,
  type AgentContext,
  type AgentResult,
} from '@taskforge/shared';
import {
  AgentRegistry,
  parseAgentStreamEvents,
  type AgentAdapter,
} from '@taskforge/agents';
import { TaskForgeDatabase, SessionRepository } from '@taskforge/persistence';
import { decideAutoDispatch } from '../src/smart-auto-dispatcher.js';
import {
  clearFileMentionCache,
  completeFileMentionAtCursor,
  listRepositoryFiles,
  resolveFileMentionsInPrompt,
} from '../src/file-mention-completer.js';
import {
  DirectConversationMemory,
  DirectAgentRunner,
} from '../src/direct-agent-session.js';
import { InteractiveShell } from '../src/interactive-shell.js';

const tempDirs: string[] = [];

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wave-a-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Sample\n');
  fs.writeFileSync(path.join(dir, 'server', 'memory.py'), 'def load(): return []\n');
  fs.writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export const auth = true;\n');
  fs.writeFileSync(path.join(dir, 'src', 'auth.test.ts'), 'export const testAuth = true;\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  clearFileMentionCache(dir);
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
      languages: ['TypeScript', 'Python'],
      tools: ['file_editor'],
    }),
    execute: handler,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    clearFileMentionCache(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Wave A — Pillar 1: Smart Auto-Dispatch', () => {
  it('routes quick Q&A and localized single-file edits directly, and scales complex/explicit-plan goals to orchestration', () => {
    const quickQa = decideAutoDispatch({
      text: 'O que faz a função load em server/memory.py?',
      availableAgents: ['codex', 'agy'],
      mentionedFiles: ['server/memory.py'],
    });
    expect(quickQa.mode).toBe('direct');
    expect(quickQa.targetAgentId).toBe('codex');
    expect(quickQa.mutationAllowed).toBe(false);

    const smallEdit = decideAutoDispatch({
      text: 'Corrige o typo no README.md',
      availableAgents: ['codex', 'agy'],
      mentionedFiles: ['README.md'],
    });
    expect(smallEdit.mode).toBe('direct');
    expect(smallEdit.mutationAllowed).toBe(true);

    const broadAudit = decideAutoDispatch({
      text: 'Veja o que ainda falta fazer nesse projeto inteiro',
      availableAgents: ['codex', 'agy'],
    });
    expect(broadAudit.mode).toBe('orchestrated');

    const greenfield = decideAutoDispatch({
      text: 'Construir um sistema de agendamento para barbearia',
      availableAgents: ['codex', 'agy'],
    });
    expect(greenfield.mode).toBe('orchestrated');

    const explicitPlan = decideAutoDispatch({
      text: 'Cria um plano para melhorar o módulo de busca',
      availableAgents: ['codex', 'agy'],
    });
    expect(explicitPlan.mode).toBe('orchestrated');

    const featureImpl = decideAutoDispatch({
      text: 'Implementa autenticação OAuth2 com refresh tokens e testes',
      availableAgents: ['codex', 'agy'],
    });
    expect(featureImpl.mode).toBe('orchestrated');

    const multiRole = decideAutoDispatch({
      text: 'Usa o claude para implementar e o codex para revisar server/memory.py',
      availableAgents: ['claude', 'codex', 'agy'],
    });
    expect(multiRole.mode).toBe('orchestrated');
  });

  it('fast-paths plain Q&A directly inside InteractiveShell when smartDirectDispatch is enabled', async () => {
    const repo = createTempRepo();
    const db = new TaskForgeDatabase(':memory:');
    const shell = new InteractiveShell({
      repoRoot: repo,
      config: getDefaultConfig(),
      database: db,
      input: new PassThrough(),
      output: new PassThrough(),
      interactive: false,
      asyncExecution: false,
      smartDirectDispatch: true,
    });

    const receivedPrompts: string[] = [];
    const internals = shell as unknown as {
      agentRegistry: AgentRegistry & { adapters: Map<string, AgentAdapter> };
    };
    internals.agentRegistry.adapters.clear();
    internals.agentRegistry.register(
      makeStubAdapter('codex', 'Codex CLI', async (_asgn, ctx) => {
        receivedPrompts.push(ctx.originalUserRequest ?? '');
        return {
          success: true,
          message: 'ok',
          output: 'load() returns an empty list in server/memory.py.',
          durationMs: 12,
          providerSessionId: 'thread-auto-1',
        };
      }),
    );

    const reply = await shell.handleInput('O que faz a função load em #server/memory.py?');
    expect(reply).toContain('load() returns an empty list');
    expect(reply).not.toContain('Plan Proposal');
    expect(receivedPrompts[0]).toBe('O que faz a função load em server/memory.py?');

    // Complex system build still produces an orchestrated Plan Proposal
    const complexReply = await shell.handleInput('Construir um sistema de agendamento para barbearia');
    expect(complexReply).toContain('Plan Proposal');

    shell.close();
  });
});

describe('Wave A — Pillar 2a: SQLite-persisted direct sessions across restarts', () => {
  it('persists direct memory, native providerSessionId, and sticky mode across shell launches and wipes on /clear', async () => {
    const repo = createTempRepo();
    const dbPath = path.join(repo, '.taskforge', 'state.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db1 = new TaskForgeDatabase(dbPath);

    const seenSessions: Array<string | undefined> = [];
    const installStub = (shell: InteractiveShell) => {
      const reg = (
        shell as unknown as {
          agentRegistry: AgentRegistry & { adapters: Map<string, AgentAdapter> };
        }
      ).agentRegistry;
      reg.adapters.clear();
      reg.register(
        makeStubAdapter('codex', 'Codex CLI', async (_asgn, ctx) => {
          seenSessions.push(ctx.providerSessionId);
          return {
            success: true,
            message: 'ok',
            output: `Reply with session ${ctx.providerSessionId ?? 'fresh'}`,
            durationMs: 10,
            providerSessionId: ctx.providerSessionId ?? 'codex-persisted-uuid',
          };
        }),
      );
    };

    const shell1 = new InteractiveShell({
      repoRoot: repo,
      config: getDefaultConfig(),
      database: db1,
      input: new PassThrough(),
      output: new PassThrough(),
      interactive: false,
      asyncExecution: false,
    });
    installStub(shell1);

    await shell1.handleInput('/use codex');
    await shell1.handleInput('Remember the keyword BLUEBIRD');
    shell1.close();

    // Relaunch on the same SQLite DB: sticky mode + memory + native session resume seamlessly!
    const db2 = new TaskForgeDatabase(dbPath);
    const shell2 = new InteractiveShell({
      repoRoot: repo,
      config: getDefaultConfig(),
      database: db2,
      input: new PassThrough(),
      output: new PassThrough(),
      interactive: false,
      asyncExecution: false,
    });
    installStub(shell2);

    // Sticky mode remained 'codex', so plain message goes straight to codex and resumes persisted thread!
    const resumedReply = await shell2.handleInput('What was the keyword?');
    expect(resumedReply).toContain('codex-persisted-uuid');
    expect(resumedReply).toContain('↻ resumed');
    expect(seenSessions).toEqual([undefined, 'codex-persisted-uuid']);

    // /clear wipes persisted direct session state in SQLite
    await shell2.handleInput('/clear');
    expect(new SessionRepository(db2).getDirectSessionState()).toBeUndefined();

    shell2.close();
  });
});

describe('Wave A — Pillar 2b: Live text streaming in Direct Mode', () => {
  it('parses Antigravity text_delta and Claude content_block_delta into agent_message events', () => {
    const id = {
      runId: 'r1',
      taskId: 'DIRECT',
      assignmentId: 'a1',
      agentId: 'agy',
      role: 'researcher',
    };
    const agyEvents = parseAgentStreamEvents(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', text_delta: 'Streaming live from AGY!' },
      }),
      id,
    );
    expect(agyEvents).toHaveLength(1);
    expect(agyEvents[0]).toMatchObject({ type: 'agent_message', text: 'Streaming live from AGY!' });

    const claudeEvents = parseAgentStreamEvents(
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello ' },
      }),
      { ...id, agentId: 'claude' },
    );
    expect(claudeEvents).toHaveLength(1);
    expect(claudeEvents[0]).toMatchObject({ type: 'agent_message', text: 'Hello ' });
  });

  it('streams chunks live to onLiveLine without duplicating identical body in final formatted output', async () => {
    const repo = createTempRepo();
    const memory = new DirectConversationMemory();
    const registry = new AgentRegistry(false);
    const liveChunks: string[] = [];

    registry.register(
      makeStubAdapter('agy', 'Google Antigravity', async (asgn, ctx) => {
        ctx.onStreamEvent?.({
          runId: 'direct',
          taskId: 'DIRECT',
          assignmentId: asgn.id,
          agentId: 'agy',
          role: 'researcher',
          type: 'agent_message',
          text: 'Hello ',
          timestamp: new Date(),
        });
        ctx.onStreamEvent?.({
          runId: 'direct',
          taskId: 'DIRECT',
          assignmentId: asgn.id,
          agentId: 'agy',
          role: 'researcher',
          type: 'agent_message',
          text: 'world!',
          timestamp: new Date(),
        });
        return {
          success: true,
          message: 'ok',
          output: 'Hello world!',
          durationMs: 15,
        };
      }),
    );

    const runner = new DirectAgentRunner({
      repoRoot: repo,
      agentRegistry: registry,
      memory,
      onLiveLine: (line) => liveChunks.push(line),
    });

    const result = await runner.runAgents(['agy'], 'Say hello');
    const liveJoined = liveChunks.join('');
    expect(liveJoined).toContain('Hello world!');
    // Outcome retains full text and memory records it, while formatted skips duplicate body
    expect(result.outcomes[0].response).toBe('Hello world!');
    expect(result.formatted).not.toContain('Hello world!');
    expect(memory.formatForPrompt()).toContain('Hello world!');
  });
});

describe('Wave A — Pillar 2c: #file repository path autocomplete & resolution', () => {
  it('completes unique and shared-prefix #file tokens and safely resolves existing repo paths', () => {
    const repo = createTempRepo();
    const files = listRepositoryFiles(repo);
    expect(files).toContain('server/memory.py');
    expect(files).toContain('src/auth.ts');

    // Unique completion adds trailing space
    const unique = completeFileMentionAtCursor('explica #mem', 'explica #mem'.length, files);
    expect(unique?.completed).toBe('server/memory.py');
    expect(unique?.nextBuffer).toBe('explica #server/memory.py ');

    // Ambiguous prefix expands longest common prefix
    const multi = completeFileMentionAtCursor('check #src/a', 'check #src/a'.length, files);
    expect(multi?.matches).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    expect(multi?.nextBuffer).toBe('check #src/auth.t');

    // Does not trigger on @agent mentions
    expect(completeFileMentionAtCursor('@codex hello', 6, files)).toBeUndefined();

    // Resolves valid #paths and ignores non-existent / traversal / issue numbers
    const resolved = resolveFileMentionsInPrompt(
      'Compare #server/memory.py with #src/auth.ts, ignore #123 and #../../etc/passwd',
      repo,
    );
    expect(resolved.files).toEqual(['server/memory.py', 'src/auth.ts']);
    expect(resolved.cleanedPrompt).toBe(
      'Compare server/memory.py with src/auth.ts, ignore #123 and #../../etc/passwd',
    );
  });
});
