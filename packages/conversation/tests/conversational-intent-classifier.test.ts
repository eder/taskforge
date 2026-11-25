import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry, OllamaAdapter } from '@taskforge/agents';
import { RunRepository, TaskForgeDatabase } from '@taskforge/persistence';
import type { DeliveryService } from '@taskforge/integration';
import { getDefaultConfig } from '@taskforge/shared';
import {
  ConversationalIntentClassifier,
  InteractiveShell,
  type PendingOrchestratedDelivery,
} from '../src/index.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function startMockHttpServer(
  handler: (reqPath: string, body: Record<string, unknown>) => { status?: number; json: unknown },
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const out = handler(req.url ?? '/', body);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ai-intent-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@taskforge.local"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "TaskForge Test"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const value = 1;\n', 'utf8');
  execSync('git add -A && git commit -m "chore: init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

const SAMPLE_PENDING_DELIVERY: PendingOrchestratedDelivery = {
  runId: 'run-demo-1',
  branch: 'taskforge/run-demo-1',
  targetBranch: 'main',
  verified: true,
  recommendedAction: 'pr',
  language: 'en',
};

describe('ConversationalIntentClassifier (Ollama -> OpenAI -> Fast-Path Fallback)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('uses local Ollama structuredQuery first when router.provider is static/ollama', async () => {
    let ollamaHits = 0;
    const mockOllama = await startMockHttpServer((reqPath) => {
      if (reqPath === '/api/tags') {
        return { json: { models: [{ name: 'qwen2.5-coder:3b' }] } };
      }
      ollamaHits += 1;
      return {
        json: {
          message: {
            role: 'assistant',
            content: JSON.stringify({ reply: 'pr', confidence: 'high' }),
          },
        },
      };
    });
    cleanups.push(mockOllama.close);

    const registry = new AgentRegistry(false);
    registry.register(new OllamaAdapter({ baseUrl: mockOllama.url, model: 'qwen2.5-coder:3b' }));
    const config = getDefaultConfig();
    config.router.provider = 'static';

    const classifier = new ConversationalIntentClassifier({
      config,
      agentRegistry: registry,
      repoRoot: process.cwd(),
      enableLiveCallsInTests: true,
    });

    const decision = await classifier.classifyDeliveryReply(
      'súbelo a GitHub como un pull request por favor',
      SAMPLE_PENDING_DELIVERY,
    );
    expect(decision).toBe('pr');
    expect(ollamaHits).toBe(1);
  });

  it('fails over automatically from unavailable Ollama to OpenAI API', async () => {
    let openAiHits = 0;
    const mockOpenAI = await startMockHttpServer(() => {
      openAiHits += 1;
      return {
        json: {
          choices: [
            {
              message: {
                content: JSON.stringify({ decision: 'approve', confidence: 'high' }),
              },
            },
          ],
        },
      };
    });
    cleanups.push(mockOpenAI.close);

    // Ollama points to an unused local port so detect() returns false.
    const registry = new AgentRegistry(false);
    registry.register(new OllamaAdapter({ baseUrl: 'http://127.0.0.1:1', model: 'qwen2.5-coder:3b' }));
    const config = getDefaultConfig();
    config.router.provider = 'static';
    config.router.baseUrl = mockOpenAI.url;
    config.router.apiKey = 'sk-test-key';

    const classifier = new ConversationalIntentClassifier({
      config,
      agentRegistry: registry,
      repoRoot: process.cwd(),
      enableLiveCallsInTests: true,
    });

    const decision = await classifier.classifyPlanApproval('dale, ejecútalo así');
    expect(decision).toBe('approve');
    expect(openAiHits).toBe(1);
  });

  it('prefers OpenAI first when router.provider is openai and fails over to Ollama on HTTP error', async () => {
    let openAiHits = 0;
    let ollamaHits = 0;

    const mockOpenAI = await startMockHttpServer(() => {
      openAiHits += 1;
      return { status: 503, json: { error: { message: 'temporarily unavailable' } } };
    });
    const mockOllama = await startMockHttpServer((reqPath) => {
      if (reqPath === '/api/tags') {
        return { json: { models: [{ name: 'qwen2.5-coder:3b' }] } };
      }
      ollamaHits += 1;
      return {
        json: {
          message: {
            role: 'assistant',
            content: JSON.stringify({ intent: 'inspect_agents', language: 'en', confidence: 'high' }),
          },
        },
      };
    });
    cleanups.push(mockOpenAI.close, mockOllama.close);

    const registry = new AgentRegistry(false);
    registry.register(new OllamaAdapter({ baseUrl: mockOllama.url, model: 'qwen2.5-coder:3b' }));
    const config = getDefaultConfig();
    config.router.provider = 'openai';
    config.router.baseUrl = mockOpenAI.url;
    config.router.apiKey = 'sk-test-key';

    const classifier = new ConversationalIntentClassifier({
      config,
      agentRegistry: registry,
      repoRoot: process.cwd(),
      enableLiveCallsInTests: true,
    });

    const res = await classifier.classifyControlPlaneIntent('which coding agents are online right now?', {
      hasReadyRun: false,
      hasDirtyWorkingTree: false,
      hasUndoCheckpoint: false,
      currentBranch: 'main',
    });
    expect(openAiHits).toBe(1);
    expect(ollamaHits).toBe(1);
    expect(res).toEqual({ intent: 'inspect_agents', language: 'en' });
  });

  it('returns undefined cleanly (Tier 1 fast-path fallback) when neither Ollama nor OpenAI is available', async () => {
    const prevKey = process.env.TASKFORGE_OPENAI_API_KEY;
    delete process.env.TASKFORGE_OPENAI_API_KEY;
    cleanups.push(() => {
      if (prevKey !== undefined) process.env.TASKFORGE_OPENAI_API_KEY = prevKey;
    });

    const registry = new AgentRegistry(false);
    registry.register(new OllamaAdapter({ baseUrl: 'http://127.0.0.1:1' }));
    const config = getDefaultConfig();
    config.router.provider = 'static';
    config.router.apiKey = undefined;

    const classifier = new ConversationalIntentClassifier({
      config,
      agentRegistry: registry,
      repoRoot: process.cwd(),
      enableLiveCallsInTests: true,
    });

    expect(await classifier.classifyDeliveryReply('ship it', SAMPLE_PENDING_DELIVERY)).toBeUndefined();
    expect(await classifier.classifyPlanApproval('go for it')).toBeUndefined();
  });

  it('rejects low-confidence or invalid enum responses and skips multi-line engineering specs', async () => {
    let calls = 0;
    const classifier = new ConversationalIntentClassifier({
      config: getDefaultConfig(),
      agentRegistry: new AgentRegistry(false),
      repoRoot: process.cwd(),
      customCaller: async (_sys, user) => {
        calls += 1;
        if (user.includes('low-conf')) return { reply: 'pr', confidence: 'low' };
        return { reply: 'delete_repo', confidence: 'high' };
      },
    });

    expect(await classifier.classifyDeliveryReply('low-conf message', SAMPLE_PENDING_DELIVERY)).toBeUndefined();
    expect(await classifier.classifyDeliveryReply('bad enum', SAMPLE_PENDING_DELIVERY)).toBeUndefined();

    const callsBefore = calls;
    const multiLine = await classifier.classifyControlPlaneIntent(
      'Implement these 3 tasks:\n1. Fix auth\n2. Add tests',
      { hasReadyRun: false, hasDirtyWorkingTree: false, hasUndoCheckpoint: false, currentBranch: 'main' },
    );
    expect(multiLine).toBeUndefined();
    expect(calls).toBe(callsBefore);

    // Even if a small model outputs intent='open_pr', asksForCodeChanges=true forces engineering_task.
    const guardedClassifier = new ConversationalIntentClassifier({
      config: getDefaultConfig(),
      agentRegistry: new AgentRegistry(false),
      repoRoot: process.cwd(),
      customCaller: async () => ({
        asksForCodeChanges: true,
        intent: 'open_pr',
        language: 'pt',
        confidence: 'high',
      }),
    });
    expect(
      await guardedClassifier.classifyControlPlaneIntent(
        'Faça todas as alterações necessárias que vc encontrou mas em Pull requests separados',
        {
          hasReadyRun: false,
          hasDirtyWorkingTree: false,
          hasUndoCheckpoint: false,
          currentBranch: 'main',
          hasRecentDirectAnalysis: true,
        },
      ),
    ).toEqual({ intent: 'engineering_task', language: 'pt' });
  });

  it('integrates end-to-end with InteractiveShell for multilingual delivery, git confirm, and control-plane commands', async () => {
    const repoRoot = initTempGitRepo();
    cleanups.push(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const db = new TaskForgeDatabase(':memory:');
    cleanups.push(() => db.close());

    // Create a completed run ready for delivery
    execSync('git checkout -b taskforge/run-ai-1', { cwd: repoRoot, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoRoot, 'app.ts'), 'export const value = 123;\n', 'utf8');
    execSync('git add -A && git commit -m "feat: update app"', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git checkout main', { cwd: repoRoot, stdio: 'ignore' });

    const shell = new InteractiveShell({
      repoRoot,
      database: db,
      interactive: false,
      intentClassifierCaller: async (systemPrompt, userContent) => {
        if (systemPrompt.includes('delivery prompt')) {
          if (userContent.includes('inspect what changed')) {
            return { reply: 'diff', confidence: 'high' };
          }
          if (userContent.includes('keep only the branch')) {
            return { reply: 'discard', confidence: 'high' };
          }
          return { reply: 'unrelated', confidence: 'high' };
        }
        if (systemPrompt.includes('multi-agent coding CLI')) {
          if (userContent.includes('quais agentes estao de pe')) {
            return { intent: 'inspect_agents', language: 'pt', confidence: 'high' };
          }
        }
        return { intent: 'engineering_task', language: 'en', confidence: 'high' };
      },
    });

    const runRepo = new RunRepository(db);
    runRepo.create('run-ai-1', undefined, { goal: 'update app.ts', baseBranch: 'main' });
    runRepo.updateStatus('run-ai-1', 'completed');
    const baseCommit = execSync('git rev-parse main', { cwd: repoRoot, encoding: 'utf8' }).trim();
    const deliveryService = (shell as unknown as { deliveryService: DeliveryService }).deliveryService;
    deliveryService.markReady('run-ai-1', 'taskforge/run-ai-1', 'main', baseCommit);
    (shell as unknown as { activeRunId?: string }).activeRunId = 'run-ai-1';
    (shell as unknown as {
      buildPostRunDeliveryPrompt: (res: { runId: string; status: string }) => string;
    }).buildPostRunDeliveryPrompt({ runId: 'run-ai-1', status: 'completed' });

    // Natural English phrasing not covered by any regex -> AI classifies as 'diff'
    const diffOut = stripAnsi(await shell.handleInput('actually let me inspect what changed first'));
    expect(diffOut).toContain('app.ts');

    // Natural English discard phrasing -> AI classifies as 'discard'
    const discardOut = stripAnsi(await shell.handleInput('forget it, keep only the branch'));
    expect(discardOut).toContain('marked as discarded');
    expect(deliveryService.getDelivery('run-ai-1')?.status).toBe('discarded');

    // Free-form Portuguese phrasing without slash command -> AI routes to inspect_agents
    const agentsOut = stripAnsi(await shell.handleInput('me diz quais agentes estao de pe agora'));
    expect(agentsOut).toContain('Available agents:');
  });
});
