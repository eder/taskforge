import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  type AgentAdapter,
  type AgentAssignment,
  type AgentCapabilities,
  type AgentContext,
  type AgentResult,
  type StructuredQueryRequest,
  type StructuredQueryResult,
} from '@taskforge/agents';
import {
  TaskForgeConfigSchema,
  resolveOpenAIApiKey,
  resolveOpenAIBaseUrl,
  resolveRouterModel,
} from '@taskforge/shared';
import { DirectAgentRunner, DirectConversationMemory, DebateCouncilRunner } from '../src/index.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ollama-arbiter-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@taskforge.local"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "TaskForge Test"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'calc.ts'), 'export const calc = () => 0;\n', 'utf8');
  execSync('git add -A && git commit -m "chore: init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

class MockCodingAgent implements AgentAdapter {
  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly fileContent: string,
    private readonly replyText: string,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['edit'],
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }

  async execute(_assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    if (context.mutationAllowed) {
      fs.writeFileSync(path.join(context.worktreePath, 'calc.ts'), this.fileContent, 'utf8');
    }
    return { success: true, message: this.replyText, output: this.replyText, durationMs: 15 };
  }
}

class MockOllamaArbiter implements AgentAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama Local';
  public structuredCalls: StructuredQueryRequest[] = [];

  constructor(private readonly responder: (req: StructuredQueryRequest) => unknown) {}

  getModelConfig() {
    return { model: 'qwen2.5-coder:7b' };
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: false,
      languages: ['TypeScript'],
      tools: ['list_files', 'read_file', 'edit_file'],
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }

  async execute(): Promise<AgentResult> {
    return { success: true, message: 'ok', output: 'ok', durationMs: 10 };
  }

  async structuredQuery(req: StructuredQueryRequest): Promise<StructuredQueryResult> {
    this.structuredCalls.push(req);
    return { value: this.responder(req), tokens: 88 };
  }
}

describe('Ollama as Local Coordinator & Solution Arbiter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('supports router.provider: ollama with automatic localhost /v1 endpoint and zero OpenAI API key', () => {
    const cfg = TaskForgeConfigSchema.parse({
      router: { provider: 'ollama' },
      agents: { ollama: { enabled: true, model: 'qwen2.5-coder:7b' } },
    });

    expect(cfg.router.provider).toBe('ollama');
    expect(resolveOpenAIBaseUrl(cfg)).toBe('http://127.0.0.1:11434/v1');
    expect(resolveOpenAIApiKey(cfg)).toBe('ollama');
    expect(resolveRouterModel(cfg)).toBe('qwen2.5-coder:7b');

    const explicitModel = TaskForgeConfigSchema.parse({
      router: { provider: 'ollama', model: 'llama3.2:latest' },
    });
    expect(resolveRouterModel(explicitModel)).toBe('llama3.2:latest');
  });

  it('uses local Ollama arbiter to compare Codex vs Antigravity diffs in competitive --edit and pick the superior solution', async () => {
    const repoRoot = initTempGitRepo();
    tempDirs.push(repoRoot);

    const registry = new AgentRegistry(false);
    registry.register(
      new MockCodingAgent(
        'codex',
        'Codex CLI',
        'export const calc = (x: number) => x * 2;\n',
        'Implemented basic multiplication.',
      ),
    );
    registry.register(
      new MockCodingAgent(
        'agy',
        'Google Antigravity',
        'export const calc = (x: number) => {\n  if (!Number.isFinite(x)) throw new RangeError("finite number required");\n  return x * 2;\n};\n',
        'Implemented multiplication with NaN/Infinity guard.',
      ),
    );
    const ollamaArbiter = new MockOllamaArbiter(() => ({
      winnerIndex: 2,
      reasoning:
        'Google Antigravity guards against NaN/Infinity inputs cleanly while keeping the diff concise.',
      hybridSuggestion: '',
    }));
    registry.register(ollamaArbiter);

    const runner = new DirectAgentRunner({
      repoRoot,
      agentRegistry: registry,
      memory: new DirectConversationMemory(),
    });

    const comp = await runner.runCompetitiveEdit(['codex', 'agy'], 'implement calc(x) safely');
    expect(ollamaArbiter.structuredCalls.length).toBe(1);
    expect(comp.pending?.recommendedIndex).toBe(2);
    expect(comp.pending?.judgeVerdict?.judgeLabel).toContain('Ollama Local');
    const clean = stripAnsi(comp.formatted);
    expect(clean).toContain('Arbiter Verdict');
    expect(clean).toContain('guards against NaN/Infinity');

    if (comp.pending) await runner.discardCompetitiveEdit(comp.pending);
  });

  it('never lets the LLM arbiter elect a candidate whose deterministic checks failed', async () => {
    const repoRoot = initTempGitRepo();
    tempDirs.push(repoRoot);

    const registry = new AgentRegistry(false);
    registry.register(
      new MockCodingAgent('codex', 'Codex CLI', 'export const calc = () => 1;\n', 'Codex edit'),
    );
    registry.register(
      new MockCodingAgent('agy', 'Google Antigravity', 'export const calc = () => 2;\n', 'Agy edit'),
    );
    const ollamaArbiter = new MockOllamaArbiter(() => ({
      winnerIndex: 1, // Would prefer #1, but #1 failed checks!
      reasoning: 'Should never override a failed verification gate.',
    }));
    registry.register(ollamaArbiter);

    const runner = new DirectAgentRunner({
      repoRoot,
      agentRegistry: registry,
      memory: new DirectConversationMemory(),
      verifyWorktree: async (wt) => {
        const content = fs.readFileSync(path.join(wt, 'calc.ts'), 'utf8');
        return content.includes('() => 2')
          ? { passed: true, summary: 'tests passed' }
          : { passed: false, summary: 'assertion failed' };
      },
    });

    const comp = await runner.runCompetitiveEdit(['codex', 'agy'], 'make calc return 2');
    // Only #2 passed deterministic checks -> arbiter is not even allowed to override #2
    expect(comp.pending?.recommendedIndex).toBe(2);
    expect(ollamaArbiter.structuredCalls.length).toBe(0);

    if (comp.pending) await runner.discardCompetitiveEdit(comp.pending);
  });

  it('uses local Ollama to synthesize @all Consensus & Divergences and /council verdicts with zero OpenAI key', async () => {
    const repoRoot = initTempGitRepo();
    tempDirs.push(repoRoot);

    const registry = new AgentRegistry(false);
    registry.register(
      new MockCodingAgent('codex', 'Codex CLI', '', 'Use Postgres advisory locks for simplicity.'),
    );
    registry.register(
      new MockCodingAgent('agy', 'Google Antigravity', '', 'Use Redis streams for high throughput.'),
    );
    const ollamaArbiter = new MockOllamaArbiter((req) => {
      if (req.prompt.includes('Debate Council')) {
        return {
          summary: 'Postgres fits current scale; Redis is only justified above 10k jobs/sec.',
          recommendedApproach: 'Start with Postgres advisory locks behind a Queue interface.',
          recommendedProposalIndex: 1,
          hybridHighlights: ['Keep a pluggable Queue interface from Antigravity'],
        };
      }
      return {
        consensus: ['Both recommend an explicit locking abstraction'],
        divergences: ['Codex favors Postgres simplicity; Antigravity favors Redis throughput'],
      };
    });
    registry.register(ollamaArbiter);

    const runner = new DirectAgentRunner({
      repoRoot,
      agentRegistry: registry,
      memory: new DirectConversationMemory(),
    });
    const consensus = await runner.synthesizeConsensus('Postgres vs Redis?', [
      { agentId: 'codex', agentName: 'Codex CLI', success: true, response: 'Postgres', durationMs: 10, filesChanged: [] },
      { agentId: 'agy', agentName: 'Google Antigravity', success: true, response: 'Redis', durationMs: 10, filesChanged: [] },
    ]);
    expect(consensus).toContain('Ollama Local');
    expect(consensus).toContain('Codex favors Postgres');

    const council = new DebateCouncilRunner({ repoRoot, agentRegistry: registry });
    const { result } = await council.runCouncil(['codex', 'agy'], 'Postgres vs Redis?', {
      saveReport: false,
    });
    expect(result.verdict.summary).toContain('Postgres fits current scale');
    expect(result.verdict.recommendedProposalIndex).toBe(1);
    expect(result.verdict.hybridHighlights).toContain('Keep a pluggable Queue interface from Antigravity');
  });
});
