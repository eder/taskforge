import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { AgentRegistry, OllamaAdapter, type AgentAdapter } from '@taskforge/agents';
import { PeerMailbox } from '@taskforge/collaboration';
import { TaskForgeDatabase } from '@taskforge/persistence';
import {
  getDefaultConfig,
  type AgentAssignment,
  type AgentContext,
  type AgentResult,
} from '@taskforge/shared';
import { WorktreeManager, WorktreePortAllocator } from '@taskforge/workspace';
import {
  LocalWebCockpitServer,
  parseUnifiedDiff,
  TaskForgeMcpServer,
  ScheduleStore,
  LocalDaemonController,
  parseScheduleIntervalMs,
  VoiceInputService,
  MultiRepoCoordinator,
  TaskForgeClient,
  DirectAgentRunner,
  DirectConversationMemory,
  DirectCheckpointManager,
  parseDirectRouteCommand,
  InteractiveShell,
} from '../src/index.js';

function createTempGitRepo(prefix = 'tf-waves-jm-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 1;\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

class MixStubAdapter implements AgentAdapter {
  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly fn: (ctx: AgentContext) => Promise<void>,
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

  async execute(_a: AgentAssignment, ctx: AgentContext): Promise<AgentResult> {
    await this.fn(ctx);
    return { success: true, message: `${this.name} done`, output: `${this.name} done`, durationMs: 20 };
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Waves J–M: Local Web Cockpit, Port Isolation, Peer Mailbox, Hybrid Mix, MCP, Daemon, Ollama, Voice, Multi-Repo & SDK', () => {
  describe('Wave J: Strictly-Local Web Cockpit (tf ui / /ui)', () => {
    it('serves live JSON state, parsed visual diffs, HTML UI, and local memory actions on 127.0.0.1', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);
      fs.writeFileSync(path.join(repoRoot, 'a.ts'), 'export const a = 42;\n', 'utf8');

      const db = new TaskForgeDatabase(':memory:');
      const server = new LocalWebCockpitServer({ repoRoot, db, port: 0 });
      const { url } = await server.start();
      try {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        const htmlRes = await fetch(`${url}/`);
        expect(htmlRes.status).toBe(200);
        expect(await htmlRes.text()).toContain('TaskForge Local Cockpit');

        const stateRes = await fetch(`${url}/api/state`);
        const state = (await stateRes.json()) as { branch: string; workingDiffFiles: Array<{ file: string; additions: number }> };
        expect(state.branch).toBe('main');
        expect(state.workingDiffFiles.some((f) => f.file === 'a.ts' && f.additions >= 1)).toBe(true);

        const diffRes = await fetch(`${url}/api/diff`);
        const diffJson = (await diffRes.json()) as { files: ReturnType<typeof parseUnifiedDiff> };
        expect(diffJson.files[0].file).toBe('a.ts');

        const actRes = await fetch(`${url}/api/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'memory_add', payload: { text: 'Use strict TS everywhere' } }),
        });
        expect(actRes.status).toBe(200);
        const state2 = (await (await fetch(`${url}/api/state`)).json()) as { memory: Array<{ text: string }> };
        expect(state2.memory.some((m) => m.text === 'Use strict TS everywhere')).toBe(true);
      } finally {
        await server.stop();
        db.close();
      }
    });
  });

  describe('Wave K: Per-Worktree Port Allocator, Peer Mailbox/Locks & Hybrid File Cherry-Pick', () => {
    it('allocates distinct collision-free port blocks per worktree and writes .taskforge.env', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);

      const allocator = new WorktreePortAllocator();
      const p1 = await allocator.allocate('T1:A1');
      const p2 = await allocator.allocate('T2:A2');
      expect(p1.basePort).not.toBe(p2.basePort);
      expect(p1.apiPort).toBe(p1.basePort + 1);
      expect(p1.dbPort).toBe(p1.basePort + 2);
      allocator.release('T1:A1');
      allocator.release('T2:A2');

      const wtMgr = new WorktreeManager(repoRoot);
      const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
      const wt1 = await wtMgr.createWorktree('TASK-1', 'asgn-1', baseHead);
      const wt2 = await wtMgr.createWorktree('TASK-2', 'asgn-2', baseHead);
      expect(wt1.ports).toBeDefined();
      expect(wt2.ports).toBeDefined();
      expect(wt1.ports!.basePort).not.toBe(wt2.ports!.basePort);
      expect(fs.existsSync(path.join(wt1.path, '.taskforge.env'))).toBe(true);

      await wtMgr.removeWorktree('TASK-1', 'asgn-1', true, true);
      await wtMgr.removeWorktree('TASK-2', 'asgn-2', true, true);
    });

    it('supports live peer-to-peer mailbox messaging and deterministic file-lock conflict detection', () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);

      const mailbox = new PeerMailbox(repoRoot, 'run-peer-1');
      const m1 = mailbox.postMessage({
        fromTaskId: 'TASK-01',
        fromAgentId: 'codex',
        kind: 'contract_update',
        subject: 'Added userId field to AuthPayload',
        body: 'Update consumers to include userId: string.',
        relatedFiles: ['src/contracts/auth.ts'],
      });
      expect(m1.seq).toBe(1);

      const inboxForPeer = mailbox.formatInboxForPrompt('TASK-02');
      expect(inboxForPeer).toContain('Added userId field');
      expect(mailbox.formatInboxForPrompt('TASK-01')).toBeUndefined();

      // Advisory file leases prevent overlapping concurrent writes
      const lock1 = mailbox.acquireLocks(['src/contracts/auth.ts'], 'TASK-01', 'codex');
      expect(lock1.acquired).toBe(true);
      const lock2 = mailbox.acquireLocks(['src/contracts/auth.ts'], 'TASK-02', 'agy');
      expect(lock2.acquired).toBe(false);
      expect(lock2.conflicts[0].ownerTaskId).toBe('TASK-01');

      expect(mailbox.releaseLocks('TASK-01')).toBe(1);
      expect(mailbox.acquireLocks(['src/contracts/auth.ts'], 'TASK-02', 'agy').acquired).toBe(true);
    });

    it('cherry-picks the best files from different competing agents via hybrid applyCompetitiveFiles + /undo', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);

      const codex = new MixStubAdapter('codex', 'Codex CLI', async (ctx) => {
        fs.writeFileSync(path.join(ctx.worktreePath, 'a.ts'), 'export const a = 100; // codex\n', 'utf8');
        fs.writeFileSync(path.join(ctx.worktreePath, 'b.ts'), 'export const b = 100; // codex\n', 'utf8');
      });
      const agy = new MixStubAdapter('agy', 'Google Antigravity', async (ctx) => {
        fs.writeFileSync(path.join(ctx.worktreePath, 'a.ts'), 'export const a = 200; // agy\n', 'utf8');
        fs.writeFileSync(path.join(ctx.worktreePath, 'b.ts'), 'export const b = 200; // agy\n', 'utf8');
      });

      const registry = new AgentRegistry(false);
      registry.register(codex);
      registry.register(agy);

      const ckpts = new DirectCheckpointManager(repoRoot);
      const runner = new DirectAgentRunner({
        repoRoot,
        agentRegistry: registry,
        memory: new DirectConversationMemory(),
        checkpointManager: ckpts,
      });

      const comp = await runner.runCompetitiveEdit(['codex', 'agy'], 'update a.ts and b.ts');
      expect(comp.pending).toBeDefined();

      const mixed = await runner.applyCompetitiveFiles(comp.pending!, [
        { file: 'a.ts', candidateIndex: 1 },
        { file: 'b.ts', candidateIndex: 2 },
      ]);
      expect(mixed).toContain('Applied hybrid file selection');
      expect(fs.readFileSync(path.join(repoRoot, 'a.ts'), 'utf8')).toContain('codex');
      expect(fs.readFileSync(path.join(repoRoot, 'b.ts'), 'utf8')).toContain('agy');

      // Undo reverts the hybrid mix cleanly!
      const undone = await ckpts.restoreLatest();
      expect(undone.success).toBe(true);
      expect(fs.readFileSync(path.join(repoRoot, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(fs.readFileSync(path.join(repoRoot, 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
    });
  });

  describe('Wave L: MCP Server, Daemon/Scheduler & TypeScript SDK', () => {
    it('handles MCP JSON-RPC initialize, tools/list, tools/call, and resources/read cleanly', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);

      const mcp = new TaskForgeMcpServer({
        repoRoot,
        executeShellCommand: async (cmd) => `executed: ${cmd}`,
      });

      const init = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe('taskforge-mcp');

      const tools = await mcp.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const toolNames = (tools?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(toolNames).toContain('taskforge_council');
      expect(toolNames).toContain('taskforge_blueprint');

      const addMem = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'taskforge_memory', arguments: { action: 'add', text: 'Always lint before PR' } },
      });
      expect(JSON.stringify(addMem?.result)).toContain('Always lint before PR');

      const readRes = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: 'taskforge://memory' },
      });
      expect(JSON.stringify(readRes?.result)).toContain('Always lint before PR');
    });

    it('persists recurring schedules, executes due jobs via LocalDaemonController, and works via TaskForgeClient SDK', async () => {
      const repoRoot = createTempGitRepo();
      tempDirs.push(repoRoot);

      expect(parseScheduleIntervalMs('30m')).toBe(30 * 60_000);
      expect(parseScheduleIntervalMs('every 6h')).toBe(6 * 60 * 60_000);
      expect(parseScheduleIntervalMs('daily')).toBe(24 * 60 * 60_000);

      const store = new ScheduleStore(repoRoot);
      const now = 1_700_000_000_000;
      const job = store.add('30m', '/memory', now);
      expect(store.list()).toHaveLength(1);
      expect(store.getDueJobs(now + 10_000)).toHaveLength(0);
      expect(store.getDueJobs(now + 31 * 60_000)).toHaveLength(1);

      const daemon = new LocalDaemonController(repoRoot);
      daemon.markStarted();
      expect(daemon.getStatus().running).toBe(true);
      const ran = await daemon.runDueSchedules(async (cmd) => `ran ${cmd}`, now + 31 * 60_000);
      expect(ran).toEqual([{ id: job.id, status: 'ok', output: 'ran /memory' }]);
      daemon.stopDaemon();
      expect(daemon.getStatus().running).toBe(false);

      // TypeScript SDK
      const sdk = new TaskForgeClient({
        repoRoot,
        config: getDefaultConfig(),
        database: new TaskForgeDatabase(':memory:'),
      });
      sdk.remember('SDK rule works');
      expect(sdk.getMemory().some((m) => m.text === 'SDK rule works')).toBe(true);
      const bp = await sdk.blueprint('Build a CLI tool with parser and runner');
      expect(bp.plan?.waves).toHaveLength(3);
      sdk.close();
    });
  });

  describe('Wave M: Ollama Adapter, Voice Input & Multi-Repo Coordinator', () => {
    it('routes @ollama mentions, supports OllamaAdapter model config, and coordinates linked sibling repos via /multirepo', async () => {
      expect(parseDirectRouteCommand('@ollama explain closures')).toEqual({
        kind: 'direct_agents',
        targets: ['ollama'],
        prompt: 'explain closures',
      });

      const ollama = new OllamaAdapter({ model: 'qwen2.5-coder:7b' });
      expect(ollama.getModelConfig().model).toBe('qwen2.5-coder:7b');
      ollama.setModelConfig({ model: 'deepseek-r1:14b' });
      expect(ollama.getModelConfig().model).toBe('deepseek-r1:14b');

      // Voice input via TASKFORGE_VOICE_CMD override
      const prevVoiceCmd = process.env.TASKFORGE_VOICE_CMD;
      process.env.TASKFORGE_VOICE_CMD = 'echo "/memory"';
      try {
        const voice = new VoiceInputService();
        const tr = await voice.recordAndTranscribe(2);
        expect(tr.ok).toBe(true);
        expect(tr.transcript).toBe('/memory');
      } finally {
        if (prevVoiceCmd === undefined) delete process.env.TASKFORGE_VOICE_CMD;
        else process.env.TASKFORGE_VOICE_CMD = prevVoiceCmd;
      }

      // Multi-repo coordinator across 2 sibling git repos
      const repoA = createTempGitRepo('tf-repo-a-');
      const repoB = createTempGitRepo('tf-repo-b-');
      tempDirs.push(repoA, repoB);

      const coord = new MultiRepoCoordinator(repoA);
      const init = coord.initFromPaths([repoB]);
      expect(init.config.repos).toHaveLength(2);
      const statuses = await coord.getStatuses();
      expect(statuses.every((s) => s.isGitRepo && s.branch === 'main')).toBe(true);

      const branchRes = await coord.createLinkedBranches('feat/shared-contract');
      expect(branchRes.every((r) => r.ok)).toBe(true);
      const afterStatuses = await coord.getStatuses();
      expect(afterStatuses.every((s) => s.branch === 'feat/shared-contract')).toBe(true);

      // InteractiveShell /schedule & /multirepo commands
      const db = new TaskForgeDatabase(':memory:');
      const shell = new InteractiveShell({
        repoRoot: repoA,
        config: getDefaultConfig(),
        database: db,
        output: new PassThrough(),
        interactive: false,
      });
      const schAdd = await shell.handleInput('/schedule add 1h /memory');
      // eslint-disable-next-line no-control-regex
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripAnsi(schAdd)).toContain('Scheduled sch-');
      expect(await shell.handleInput('/multirepo status')).toContain('feat/shared-contract');
      db.close();
    });
  });
});
