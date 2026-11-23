import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { AgentRegistry, type AgentAdapter } from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import {
  getDefaultConfig,
  type AgentAssignment,
  type AgentContext,
  type AgentResult,
} from '@taskforge/shared';
import {
  parseCouncilCommand,
  DebateCouncilRunner,
  DirectConversationMemory,
  formatCouncilProposalThread,
  buildCouncilHandoffGoal,
  loadLivingPlan,
  InteractiveShell,
} from '../src/index.js';

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wave-d-council-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const app = true;\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

class CouncilStubAdapter implements AgentAdapter {
  public calls: Array<{ taskId: string; prompt: string; mutationAllowed?: boolean }> = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly respond: (taskId: string, prompt: string) => string,
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
      mutationAllowed: context.mutationAllowed,
    });
    const out = this.respond(assignment.taskId, assignment.objective);
    return { success: true, message: out, output: out, durationMs: 45 };
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Wave D: Multi-Agent Solution Debate Council', () => {
  it('parses /council, /debate, explicit agent subsets, and PT/EN natural-language council triggers', () => {
    expect(parseCouncilCommand('/council Como projetar cache distribuído?')).toEqual({
      targets: 'all',
      problem: 'Como projetar cache distribuído?',
    });

    expect(parseCouncilCommand('/debate @codex @agy event sourcing vs CRUD')).toEqual({
      targets: ['codex', 'agy'],
      problem: 'event sourcing vs CRUD',
    });

    expect(
      parseCouncilCommand('discutam a melhor solução para autenticação multi-tenant com refresh tokens'),
    ).toEqual({
      targets: 'all',
      problem: 'autenticação multi-tenant com refresh tokens',
    });

    expect(
      parseCouncilCommand('faz um council sobre estratégia de migração zero-downtime'),
    ).toEqual({
      targets: 'all',
      problem: 'estratégia de migração zero-downtime',
    });

    expect(
      parseCouncilCommand('have the agents debate the best solution for rate limiting'),
    ).toEqual({
      targets: 'all',
      problem: 'rate limiting',
    });

    expect(parseCouncilCommand('corrige o bug em index.ts')).toBeUndefined();
  });

  it('executes all 3 rounds with dedicated per-solution cross-critiques across 3 agents, saves report, and formats inspection threads', async () => {
    const repoRoot = createTempRepo();
    tempDirs.push(repoRoot);

    const codex = new CouncilStubAdapter('codex', 'Codex CLI', (taskId) => {
      if (taskId.startsWith('PROPOSAL')) return 'Proposal by Codex: Outbox table in Postgres with SKIP LOCKED worker.';
      if (taskId.startsWith('CRITIQUE')) return 'Codex critique: Watch out for dual-write inconsistency; add idempotency keys.';
      return 'Refined Codex solution: Postgres Outbox + idempotency keys + dead-letter queue.';
    });
    const agy = new CouncilStubAdapter('agy', 'Google Antigravity', (taskId) => {
      if (taskId.startsWith('PROPOSAL')) return 'Proposal by AGY: Redis Streams consumer groups with ack timeouts.';
      if (taskId.startsWith('CRITIQUE')) return 'AGY critique: Postgres polling adds DB load; add LISTEN/NOTIFY wakeups.';
      return 'Refined AGY solution: Hybrid Postgres Outbox triggering Redis Streams fan-out.';
    });
    const claude = new CouncilStubAdapter('claude', 'Claude Code', (taskId) => {
      if (taskId.startsWith('PROPOSAL')) return 'Proposal by Claude: Temporal workflow engine for durable retries.';
      if (taskId.startsWith('CRITIQUE')) return 'Claude critique: Ensure schema versioning and bounded backoff on every handler.';
      return 'Refined Claude solution: Lightweight outbox first, migrate to Temporal only when DAGs grow.';
    });

    const registry = new AgentRegistry(false);
    registry.register(codex);
    registry.register(agy);
    registry.register(claude);

    const memory = new DirectConversationMemory();
    const runner = new DebateCouncilRunner({
      repoRoot,
      agentRegistry: registry,
      memory,
      synthesizer: async () => ({
        summary: 'Hybrid Postgres Outbox with LISTEN/NOTIFY wakeups and idempotency keys wins for simplicity and durability.',
        recommendedApproach: 'Use Postgres transactional outbox with SKIP LOCKED, LISTEN/NOTIFY wakeups, and idempotency keys.',
        recommendedProposalIndex: 1,
        hybridHighlights: [
          'Transactional durability from Codex Proposal #1',
          'Low-latency LISTEN/NOTIFY wakeups from AGY critique',
          'Schema versioning & bounded backoff from Claude critique',
        ],
      }),
    });

    const { result, pending } = await runner.runCouncil(
      ['codex', 'agy', 'claude'],
      'Qual a melhor arquitetura de fila assíncrona resiliente?',
    );

    // Round 1: 3 independent proposals (all read-only!)
    expect(result.proposals).toHaveLength(3);
    // Round 2: EVERY solution critiqued by EVERY other agent -> 3 * 2 = 6 dedicated critiques!
    expect(result.critiques).toHaveLength(6);
    for (const propIdx of [1, 2, 3]) {
      const critiquesForProp = result.critiques.filter((c) => c.targetProposalIndex === propIdx);
      expect(critiquesForProp).toHaveLength(2);
    }
    // Round 3: 3 proponent refinements, each receiving critiques specifically directed at its own proposal!
    expect(result.refinements).toHaveLength(3);
    const codexRefineCall = codex.calls.find((c) => c.taskId === 'REFINE-P1');
    expect(codexRefineCall?.prompt).toContain('Critiques received specifically on your Proposal #1');
    expect(codexRefineCall?.prompt).toContain('LISTEN/NOTIFY');
    expect(codexRefineCall?.prompt).toContain('schema versioning');

    // Every single call must stay strictly read-only
    for (const adapter of [codex, agy, claude]) {
      expect(adapter.calls.every((c) => c.mutationAllowed === false)).toBe(true);
    }

    // Verdict persisted to .taskforge/councils/*.md and recorded in shared memory
    expect(result.verdict?.savedReportPath).toContain('.taskforge/councils/');
    expect(fs.existsSync(path.join(repoRoot, result.verdict!.savedReportPath!))).toBe(true);
    expect(memory.getEntries().some((e) => e.kind === 'agent' && e.agentId === 'council')).toBe(true);

    // Thread inspection & handoff prompt builder
    expect(pending).toBeDefined();
    const thread = formatCouncilProposalThread(pending!, 1);
    expect(thread).toContain('Round 1 — Initial Proposal');
    expect(thread).toContain('Round 2 — Critique by Google Antigravity');
    expect(thread).toContain('Round 2 — Critique by Claude Code');
    expect(thread).toContain('Round 3 — Refined Solution');

    const handoffGoal = buildCouncilHandoffGoal(pending!, 'verdict');
    expect(handoffGoal).toContain('Postgres transactional outbox');
    expect(handoffGoal).toContain('LISTEN/NOTIFY');
  });

  it('integrates end-to-end in InteractiveShell: /council -> inspect 1 -> blueprint handoff into .taskforge/plan.md', async () => {
    const repoRoot = createTempRepo();
    tempDirs.push(repoRoot);

    const db = new TaskForgeDatabase(':memory:');
    const out = new PassThrough();
    const shell = new InteractiveShell({
      repoRoot,
      config: getDefaultConfig(),
      database: db,
      output: out,
      interactive: false,
      councilSynthesizer: async () => ({
        summary: 'Adopt modular plugin registry with TypeScript contracts.',
        recommendedApproach: 'Build a TypeScript plugin system with core, registry, and loader modules.',
        recommendedProposalIndex: 1,
        hybridHighlights: ['Strict contract validation', 'Hot-reloadable plugin loader'],
      }),
    });

    // Replace registered adapters on the shell's internal registry with deterministic stubs
    const registry = (shell as unknown as { agentRegistry: AgentRegistry }).agentRegistry;
    registry.clear();
    registry.register(
      new CouncilStubAdapter('codex', 'Codex CLI', () => 'Use static typed plugin contracts.'),
    );
    registry.register(
      new CouncilStubAdapter('agy', 'Google Antigravity', () => 'Add dynamic manifest discovery and sandbox.'),
    );

    const councilOut = await shell.handleInput('/council @codex @agy como desenhar sistema de plugins?');
    expect(councilOut).toContain('Multi-Agent Solution Debate Council');
    expect(councilOut).toContain('Solution #1 — Codex CLI');
    expect(councilOut).toContain('Solution #2 — Google Antigravity');
    expect(councilOut).toContain('Council Verdict');
    expect(councilOut).toContain('Adopt modular plugin registry');

    // Inspect Solution #1 full 3-round thread without losing pending state
    const inspected = await shell.handleInput('inspect 1');
    expect(inspected).toContain('Full Thread — Solution #1 (Codex CLI)');
    expect(inspected).toContain('Round 2 — Critique by Google Antigravity');

    // Turn Council Verdict directly into a Wave C Living Plan (.taskforge/plan.md)!
    const blueprintOut = await shell.handleInput('blueprint');
    expect(blueprintOut).toContain('Living Plan');
    expect(blueprintOut).toContain('Wave 1: Foundation & Shared Contracts');
    expect(loadLivingPlan(repoRoot)).toBeDefined();

    db.close();
  });
});
