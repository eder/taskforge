import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentRegistry } from '@taskforge/agents';
import { AgentDetector } from '@taskforge/agents';
import {
  DEFAULT_OPENAI_BASE_URL,
  type AgentAssignment,
  type AgentContext,
} from '@taskforge/shared';
import { colors } from './theme.js';
import { resolveFileMentionsInPrompt } from './file-mention-completer.js';
import { normalizeAgentAlias } from './direct-agent-router.js';
import type { DirectConversationMemory } from './direct-agent-session.js';

export interface CouncilProposal {
  index: number;
  agentId: string;
  agentName: string;
  content: string;
  durationMs: number;
  tokensUsed?: number;
  success: boolean;
  error?: string;
}

export interface CouncilCritique {
  targetProposalIndex: number;
  targetAgentId: string;
  targetAgentName: string;
  criticAgentId: string;
  criticAgentName: string;
  content: string;
  durationMs: number;
  tokensUsed?: number;
  success: boolean;
  error?: string;
}

export interface CouncilRefinement {
  proposalIndex: number;
  agentId: string;
  agentName: string;
  content: string;
  durationMs: number;
  tokensUsed?: number;
  success: boolean;
  error?: string;
}

export interface CouncilVerdict {
  summary: string;
  recommendedApproach: string;
  recommendedProposalIndex?: number;
  hybridHighlights: string[];
  savedReportPath?: string;
}

export interface CouncilSessionResult {
  id: string;
  problem: string;
  proposals: CouncilProposal[];
  critiques: CouncilCritique[];
  refinements: CouncilRefinement[];
  verdict?: CouncilVerdict;
  formatted: string;
}

export interface PendingCouncilDecision {
  id: string;
  problem: string;
  proposals: CouncilProposal[];
  critiques: CouncilCritique[];
  refinements: CouncilRefinement[];
  verdict: CouncilVerdict;
}

export type CouncilSynthesizerFn = (input: {
  problem: string;
  proposals: CouncilProposal[];
  critiques: CouncilCritique[];
  refinements: CouncilRefinement[];
}) => Promise<CouncilVerdict | undefined>;

export interface DebateCouncilOptions {
  repoRoot: string;
  agentRegistry: AgentRegistry;
  memory?: DirectConversationMemory;
  timeoutMs?: number;
  onLiveLine?: (line: string) => void;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiModel?: string;
  synthesizer?: CouncilSynthesizerFn;
  onStateChanged?: () => void;
}

const COUNCIL_NL_PATTERNS: RegExp[] = [
  /^(?:(?:faz(?:er)?|fa[çc]a|inicia(?:r)?|abre|abrir|cria(?:r)?|roda(?:r)?)\s+(?:um\s+|o\s+)?)?(?:council|conselho|debate(?:\s+council)?)\s+(?:entre\s+(?:os\s+)?agentes\s+)?(?:sobre|para|de|:)?\s*(.+)$/i,
  /^(?:discut(?:am|ir|e)\s+(?:entre\s+(?:si|voc[eê]s|os\s+agentes)\s+)?(?:qual\s+(?:[eé]\s+)?)?(?:a\s+melhor\s+solu[çc][aã]o\s+(?:para|de)|sobre)?)\s*(.+)$/i,
  /^(?:(?:start|run|open|hold)\s+(?:a\s+)?)?(?:solution\s+)?(?:debate\s+)?council\s+(?:on|for|about|:)?\s*(.+)$/i,
  /^(?:have\s+the\s+agents\s+(?:debate|discuss)\s+(?:the\s+best\s+solution\s+(?:for|to)|about)?)\s*(.+)$/i,
];

/**
 * Parses `/council [@a @b] <problem>`, `/debate [@a @b] <problem>`, or natural-language
 * council requests (PT & EN) into target agents + problem statement.
 */
export function parseCouncilCommand(
  rawInput: string,
  knownAgentIds?: Iterable<string>,
): { targets: 'all' | string[]; problem: string } | undefined {
  const text = rawInput.trim();
  if (!text) return undefined;

  const known = new Set<string>(knownAgentIds ? [...knownAgentIds].map((id) => id.toLowerCase()) : []);
  const resolveAgent = (token: string): string | undefined => {
    const lower = token.toLowerCase();
    const mapped = normalizeAgentAlias(lower);
    if (mapped) return mapped;
    return known.has(lower) ? lower : undefined;
  };

  let body: string | undefined;
  const slashMatch = /^\/(?:council|debate)(?:\s+(.*))?$/i.exec(text);
  if (slashMatch) {
    body = (slashMatch[1] ?? '').trim();
    if (!body) return { targets: 'all', problem: '' };
  } else if (!text.startsWith('/') && !text.startsWith('@') && !text.startsWith('!')) {
    for (const re of COUNCIL_NL_PATTERNS) {
      const m = re.exec(text);
      if (m && m[1]?.trim().length >= 6) {
        body = m[1].trim();
        break;
      }
    }
  }

  if (!body) return undefined;

  // Extract optional leading `@agent` subset (e.g. `/council @codex @agy how to scale queues?`)
  const explicitTargets: string[] = [];
  let rest = body;
  while (rest.startsWith('@')) {
    const m = /^@([a-zA-Z0-9_-]+)(?:[:,])?\s+/.exec(rest);
    if (!m) break;
    const token = m[1].toLowerCase();
    if (token === 'all' || token === 'todos') {
      rest = rest.slice(m[0].length).trimStart();
      continue;
    }
    const resolved = resolveAgent(token);
    if (!resolved) break;
    if (!explicitTargets.includes(resolved)) explicitTargets.push(resolved);
    rest = rest.slice(m[0].length).trimStart();
  }

  return {
    targets: explicitTargets.length > 0 ? explicitTargets : 'all',
    problem: rest.trim(),
  };
}

/**
 * Multi-Agent Solution Debate Council (Wave D):
 *
 * - Round 1: Each participating agent independently proposes a complete solution
 *   (approach, trade-offs, risks, complexity, affected files).
 * - Round 2: Every proposed solution receives dedicated, solution-specific
 *   cross-critiques from every other agent (blind spots, concrete improvements,
 *   and alternative angles) — run in parallel across all `(critic, proposal)` pairs.
 * - Round 3: Each proponent reads all critiques directed at its own solution
 *   and produces a refined solution (adopting improvements, addressing flaws, or
 *   conceding/merging stronger peer ideas).
 * - Verdict: Synthesizes a ranked Council Verdict + merged hybrid recommendation,
 *   saves the full transcript to `.taskforge/councils/`, and offers 1-Enter handoff
 *   to implement directly or turn into a Living Plan (`.taskforge/plan.md`).
 */
export class DebateCouncilRunner {
  private readonly repoRoot: string;
  private readonly agentRegistry: AgentRegistry;
  private readonly memory?: DirectConversationMemory;
  private readonly timeoutMs: number;
  private readonly onLiveLine?: (line: string) => void;
  private readonly openAiApiKey?: string;
  private readonly openAiBaseUrl: string;
  private readonly openAiModel: string;
  private readonly synthesizer?: CouncilSynthesizerFn;
  private readonly onStateChanged?: () => void;

  constructor(options: DebateCouncilOptions) {
    this.repoRoot = options.repoRoot;
    this.agentRegistry = options.agentRegistry;
    this.memory = options.memory;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.onLiveLine = options.onLiveLine;
    this.openAiApiKey = options.openAiApiKey;
    this.openAiBaseUrl = (options.openAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
    this.openAiModel = options.openAiModel ?? 'gpt-4o-mini';
    this.synthesizer = options.synthesizer;
    this.onStateChanged = options.onStateChanged;
  }

  private async resolveAdapters(
    targets: 'all' | string[],
  ): Promise<{ adapters: AgentAdapter[]; unavailable: string[] }> {
    if (targets === 'all') {
      const reports = await AgentDetector.detect(this.agentRegistry.list());
      const ready = reports
        .filter((r) => r.ready)
        .map((r) => this.agentRegistry.get(r.id))
        .filter((a): a is AgentAdapter => Boolean(a));
      return { adapters: ready, unavailable: [] };
    }
    const adapters: AgentAdapter[] = [];
    const unavailable: string[] = [];
    for (const id of targets) {
      const adapter = this.agentRegistry.get(id);
      if (!adapter) {
        unavailable.push(`${id} (not registered)`);
        continue;
      }
      const ok = await adapter.detect();
      if (!ok) {
        unavailable.push(`${adapter.name} (${id} not ready)`);
        continue;
      }
      adapters.push(adapter);
    }
    return { adapters, unavailable };
  }

  private async executeReadOnlyTurn(
    adapter: AgentAdapter,
    taskId: string,
    originalProblem: string,
    prompt: string,
    conversationHistory?: string,
    abortSignal?: AbortSignal,
  ): Promise<{ success: boolean; content: string; durationMs: number; tokensUsed?: number; error?: string }> {
    const start = Date.now();
    const assignment: AgentAssignment = {
      id: `council-${taskId.toLowerCase()}-${adapter.id}-${randomUUID().slice(0, 6)}`,
      taskId,
      agentId: adapter.id,
      role: taskId.startsWith('CRITIQUE') ? 'reviewer' : 'researcher',
      objective: prompt,
      status: 'running',
    };
    const context: AgentContext = {
      worktreePath: this.repoRoot,
      originalUserRequest: originalProblem,
      conversationHistory,
      directMode: true,
      mutationAllowed: false,
      timeoutMs: this.timeoutMs,
      abortSignal,
      assignment,
      task: {
        objective: prompt,
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Provide concrete, evidence-based engineering analysis'],
        dependencies: [],
      },
      onStreamEvent: (ev) => {
        if (ev.type === 'file_read') {
          this.onLiveLine?.(`  ${colors.dim}[${adapter.name}·${taskId}] Read ${ev.path}${colors.reset}\n`);
        }
      },
    };
    try {
      const res = await adapter.execute(assignment, context);
      return {
        success: res.success,
        content: (res.output || res.message || '').trim() || (res.success ? '(no output)' : 'Failed'),
        durationMs: res.durationMs || Date.now() - start,
        tokensUsed: res.usage?.totalTokens,
        error: res.success ? undefined : res.message || 'Execution failed',
      };
    } catch (err) {
      return {
        success: false,
        content: '',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async runCouncil(
    targets: 'all' | string[],
    rawProblem: string,
    options: { abortSignal?: AbortSignal; saveReport?: boolean } = {},
  ): Promise<{ result: CouncilSessionResult; pending?: PendingCouncilDecision }> {
    const resolvedMentions = resolveFileMentionsInPrompt(rawProblem, this.repoRoot);
    const problem = resolvedMentions.cleanedPrompt;
    const councilId = `council-${Date.now().toString(36)}`;

    const { adapters, unavailable } = await this.resolveAdapters(targets);
    if (adapters.length < 2) {
      const detail =
        unavailable.length > 0
          ? `Unavailable: ${unavailable.join(', ')}.`
          : `Found only ${adapters.length} ready agent(s). At least 2 ready agents are required for a Solution Debate Council (check /agents or /health).`;
      return {
        result: {
          id: councilId,
          problem,
          proposals: [],
          critiques: [],
          refinements: [],
          formatted: `${colors.red}✖ Cannot convene Debate Council.${colors.reset} ${detail}`,
        },
      };
    }

    const historySnapshot = this.memory?.formatForPrompt() || undefined;
    this.memory?.record({
      kind: 'user',
      text: `[council ${adapters.map((a) => a.id).join(', ')}] ${problem}`,
      timestamp: new Date().toISOString(),
    });

    const participantNames = adapters.map((a) => `${colors.bold}${a.name}${colors.reset}`).join(' · ');
    this.onLiveLine?.(
      `\n  ${colors.brand}✦ ${colors.bold}Multi-Agent Solution Debate Council${colors.reset} ${colors.dim}(${adapters.length} agents · 3 rounds · read-only)${colors.reset}\n  ${colors.dim}Members:${colors.reset} ${participantNames}\n`,
    );

    // ── ROUND 1: Independent Solution Proposals (parallel) ──
    this.onLiveLine?.(`\n  ${colors.cyan}▸ Round 1/3:${colors.reset} Independent solution proposals...\n`);
    const round1Prompt = [
      `Problem to solve:\n${problem}`,
      '',
      'You are participating in Round 1 of a Multi-Agent Solution Debate Council (read-only).',
      'Propose your BEST concrete engineering solution. Structure your response crisply with:',
      '1. **Core Approach**: how it works and why it fits this codebase',
      '2. **Trade-offs & Complexity**: pros, cons, and effort',
      '3. **Key Risks & Edge Cases**: what could go wrong and how to mitigate',
      '4. **Files / Modules Affected**: concrete paths or boundaries',
      'Reply in the same language as the problem statement.',
    ].join('\n');

    const proposals: CouncilProposal[] = await Promise.all(
      adapters.map(async (adapter, idx) => {
        const res = await this.executeReadOnlyTurn(
          adapter,
          `PROPOSAL-${idx + 1}`,
          problem,
          round1Prompt,
          historySnapshot,
          options.abortSignal,
        );
        return {
          index: idx + 1,
          agentId: adapter.id,
          agentName: adapter.name,
          content: res.content,
          durationMs: res.durationMs,
          tokensUsed: res.tokensUsed,
          success: res.success,
          error: res.error,
        };
      }),
    );

    const viableProposals = proposals.filter((p) => p.success && p.content.trim().length > 0);
    if (viableProposals.length < 2) {
      const failedSummary = proposals
        .map((p) => `  • ${p.agentName}: ${p.success ? 'ok' : p.error || 'failed'}`)
        .join('\n');
      return {
        result: {
          id: councilId,
          problem,
          proposals,
          critiques: [],
          refinements: [],
          formatted: `${colors.red}✖ Debate Council stopped after Round 1 (fewer than 2 viable proposals).${colors.reset}\n${failedSummary}`,
        },
      };
    }

    // ── ROUND 2: Dedicated Per-Solution Cross-Critiques (parallel across all (critic, proposal) pairs) ──
    const critiquePairs: Array<{ critic: AgentAdapter; target: CouncilProposal }> = [];
    for (const target of viableProposals) {
      for (const critic of adapters) {
        if (critic.id === target.agentId) continue;
        critiquePairs.push({ critic, target });
      }
    }
    this.onLiveLine?.(
      `  ${colors.cyan}▸ Round 2/3:${colors.reset} Dedicated cross-critique of each proposed solution (${critiquePairs.length} reviews in parallel)...\n`,
    );

    const critiques: CouncilCritique[] = await Promise.all(
      critiquePairs.map(async ({ critic, target }) => {
        const critiquePrompt = [
          `Problem:\n${problem}`,
          `\nSolution under discussion — Proposal #${target.index} by ${target.agentName} (${target.agentId}):\n${target.content.slice(0, 3200)}`,
          '',
          `You are ${critic.name} reviewing Proposal #${target.index} specifically (read-only).`,
          'Discuss THIS proposed solution thoroughly and constructively:',
          '1. **Strengths to Keep**: what works well in this proposal',
          '2. **Blind Spots & Edge Cases**: concrete flaws, scaling limits, or hidden risks',
          '3. **Concrete Improvements**: specific changes that would make Proposal #' + target.index + ' stronger',
          '4. **Alternative Angles**: any better mechanism or hybrid idea worth combining',
          'Keep it sharp and actionable. Reply in the same language as the problem statement.',
        ].join('\n');

        const res = await this.executeReadOnlyTurn(
          critic,
          `CRITIQUE-P${target.index}`,
          problem,
          critiquePrompt,
          undefined,
          options.abortSignal,
        );
        return {
          targetProposalIndex: target.index,
          targetAgentId: target.agentId,
          targetAgentName: target.agentName,
          criticAgentId: critic.id,
          criticAgentName: critic.name,
          content: res.content,
          durationMs: res.durationMs,
          tokensUsed: res.tokensUsed,
          success: res.success,
          error: res.error,
        };
      }),
    );

    // ── ROUND 3: Proponent Refinement / Defense / Hybrid Concession (parallel) ──
    this.onLiveLine?.(
      `  ${colors.cyan}▸ Round 3/3:${colors.reset} Proponents refining solutions based on peer critiques...\n`,
    );

    const refinements: CouncilRefinement[] = await Promise.all(
      viableProposals.map(async (prop) => {
        const adapter = adapters.find((a) => a.id === prop.agentId)!;
        const incomingCritiques = critiques.filter(
          (c) => c.targetProposalIndex === prop.index && c.success && c.content.trim().length > 0,
        );
        const peerProposals = viableProposals.filter((p) => p.index !== prop.index);

        const refinePrompt = [
          `Problem:\n${problem}`,
          `\nYour Round 1 Proposal (#${prop.index}):\n${prop.content.slice(0, 2200)}`,
          incomingCritiques.length > 0
            ? `\nCritiques received specifically on your Proposal #${prop.index}:\n` +
              incomingCritiques
                .map((c) => `--- Critique by ${c.criticAgentName} ---\n${c.content.slice(0, 1800)}`)
                .join('\n\n')
            : '',
          peerProposals.length > 0
            ? `\nOther proposals in the Council:\n` +
              peerProposals
                .map((p) => `--- Proposal #${p.index} (${p.agentName}) ---\n${p.content.slice(0, 1400)}`)
                .join('\n\n')
            : '',
          '',
          'Round 3 instructions (read-only):',
          '1. Address each valid blind spot raised against your proposal.',
          '2. Incorporate concrete improvements or superior ideas from peer proposals (or concede clearly if a hybrid/peer approach is better).',
          '3. Present your crisp **Final Refined Solution** ready for implementation.',
          'Reply in the same language as the problem statement.',
        ]
          .filter(Boolean)
          .join('\n');

        const res = await this.executeReadOnlyTurn(
          adapter,
          `REFINE-P${prop.index}`,
          problem,
          refinePrompt,
          undefined,
          options.abortSignal,
        );
        return {
          proposalIndex: prop.index,
          agentId: prop.agentId,
          agentName: prop.agentName,
          content: res.content,
          durationMs: res.durationMs,
          tokensUsed: res.tokensUsed,
          success: res.success,
          error: res.error,
        };
      }),
    );

    // ── VERDICT SYNTHESIS ──
    const verdict = await this.synthesizeVerdict(problem, viableProposals, critiques, refinements);

    if (options.saveReport !== false) {
      verdict.savedReportPath = this.saveCouncilReport(
        councilId,
        problem,
        viableProposals,
        critiques,
        refinements,
        verdict,
      );
    }

    this.memory?.record({
      kind: 'agent',
      agentId: 'council',
      agentName: 'Solution Debate Council',
      response: `${verdict.summary}\n\nRecommended approach:\n${verdict.recommendedApproach}`,
      durationMs: proposals.reduce((sum, p) => sum + p.durationMs, 0),
      filesChanged: [],
      timestamp: new Date().toISOString(),
    });
    this.onStateChanged?.();

    const formatted = formatCouncilOutput({
      id: councilId,
      problem,
      proposals: viableProposals,
      critiques,
      refinements,
      verdict,
      unavailable,
    });

    const result: CouncilSessionResult = {
      id: councilId,
      problem,
      proposals: viableProposals,
      critiques,
      refinements,
      verdict,
      formatted,
    };

    const pending: PendingCouncilDecision = {
      id: councilId,
      problem,
      proposals: viableProposals,
      critiques,
      refinements,
      verdict,
    };

    return { result, pending };
  }

  private async synthesizeVerdict(
    problem: string,
    proposals: CouncilProposal[],
    critiques: CouncilCritique[],
    refinements: CouncilRefinement[],
  ): Promise<CouncilVerdict> {
    if (this.synthesizer) {
      try {
        const custom = await this.synthesizer({ problem, proposals, critiques, refinements });
        if (custom && custom.summary.trim()) return custom;
      } catch {
        // fall through
      }
    }

    if (this.openAiApiKey && !process.env.VITEST) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
          const res = await fetch(`${this.openAiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.openAiApiKey}`,
            },
            body: JSON.stringify({
              model: this.openAiModel,
              temperature: 0.2,
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content:
                    'You are the chairperson of a Multi-Agent Engineering Debate Council. Given independent proposals, per-proposal cross-critiques, and refined solutions, produce a strict JSON verdict in the SAME language as the problem: { summary: string, recommendedApproach: string, recommendedProposalIndex: number, hybridHighlights: string[] }. Keep summary crisp (3-5 sentences), recommendedApproach concrete and actionable, and hybridHighlights to 3-5 bullet strings showing the best ideas merged across proposals.',
                },
                {
                  role: 'user',
                  content: [
                    `Problem:\n${problem}`,
                    ...proposals.map((p) => `\nProposal #${p.index} (${p.agentName}):\n${p.content.slice(0, 1500)}`),
                    ...critiques
                      .filter((c) => c.success)
                      .map(
                        (c) =>
                          `\nCritique of #${c.targetProposalIndex} by ${c.criticAgentName}:\n${c.content.slice(0, 900)}`,
                      ),
                    ...refinements
                      .filter((r) => r.success)
                      .map((r) => `\nRefined #${r.proposalIndex} (${r.agentName}):\n${r.content.slice(0, 1500)}`),
                  ].join('\n'),
                },
              ],
            }),
            signal: controller.signal,
          });
          if (res.ok) {
            const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const raw = json.choices?.[0]?.message?.content;
            if (raw) {
              const parsed = JSON.parse(raw) as Partial<CouncilVerdict>;
              if (typeof parsed.summary === 'string' && typeof parsed.recommendedApproach === 'string') {
                return {
                  summary: parsed.summary.trim(),
                  recommendedApproach: parsed.recommendedApproach.trim(),
                  recommendedProposalIndex:
                    typeof parsed.recommendedProposalIndex === 'number'
                      ? parsed.recommendedProposalIndex
                      : proposals[0]?.index,
                  hybridHighlights: Array.isArray(parsed.hybridHighlights)
                    ? parsed.hybridHighlights.map(String).slice(0, 6)
                    : [],
                };
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // fall through to deterministic synthesis
      }
    }

    return buildDeterministicCouncilVerdict(problem, proposals, critiques, refinements);
  }

  private saveCouncilReport(
    councilId: string,
    problem: string,
    proposals: CouncilProposal[],
    critiques: CouncilCritique[],
    refinements: CouncilRefinement[],
    verdict: CouncilVerdict,
  ): string | undefined {
    try {
      const dir = path.join(this.repoRoot, '.taskforge', 'councils');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${councilId}.md`);
      const md: string[] = [
        `# Solution Debate Council — ${councilId}`,
        '',
        `> **Problem:** ${problem}`,
        `> **Participants:** ${proposals.map((p) => `${p.agentName} (${p.agentId})`).join(', ')}`,
        '',
        '## Council Verdict',
        '',
        verdict.summary,
        '',
        '### Recommended Approach',
        '',
        verdict.recommendedApproach,
        '',
      ];
      if (verdict.hybridHighlights.length > 0) {
        md.push('### Best Ideas Merged Across Proposals', '');
        for (const h of verdict.hybridHighlights) md.push(`- ${h}`);
        md.push('');
      }
      for (const prop of proposals) {
        md.push(`## Proposal #${prop.index} — ${prop.agentName}`, '', prop.content, '');
        const propCritiques = critiques.filter((c) => c.targetProposalIndex === prop.index && c.success);
        for (const c of propCritiques) {
          md.push(`### Critique by ${c.criticAgentName}`, '', c.content, '');
        }
        const ref = refinements.find((r) => r.proposalIndex === prop.index && r.success);
        if (ref) {
          md.push(`### Round 3 Refinement (${ref.agentName})`, '', ref.content, '');
        }
      }
      fs.writeFileSync(filePath, md.join('\n'), 'utf8');
      return path.relative(this.repoRoot, filePath) || filePath;
    } catch {
      return undefined;
    }
  }
}

function firstMeaningfulLine(text: string, maxLen = 180): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim().replace(/^[#*\-•\d.)\s]+/, ''))
      .find((l) => l.length > 12)
      ?.slice(0, maxLen) ?? text.slice(0, maxLen)
  );
}

function buildDeterministicCouncilVerdict(
  problem: string,
  proposals: CouncilProposal[],
  critiques: CouncilCritique[],
  refinements: CouncilRefinement[],
): CouncilVerdict {
  const bestRefined =
    refinements
      .filter((r) => r.success && r.content.trim().length > 0)
      .sort((a, b) => b.content.length - a.content.length)[0];
  const recommendedIdx = bestRefined?.proposalIndex ?? proposals[0]?.index ?? 1;
  const recommendedProp = proposals.find((p) => p.index === recommendedIdx) ?? proposals[0];

  const hybridHighlights = proposals.map((prop) => {
    const ref = refinements.find((r) => r.proposalIndex === prop.index && r.success);
    const critCount = critiques.filter((c) => c.targetProposalIndex === prop.index && c.success).length;
    const lead = firstMeaningfulLine(ref?.content || prop.content, 150);
    return `Proposal #${prop.index} (${prop.agentName}, ${critCount} peer critique${critCount === 1 ? '' : 's'}): ${lead}`;
  });

  const recommendedApproach = bestRefined?.content || recommendedProp?.content || problem;

  return {
    summary: `All ${proposals.length} proposals were independently stress-tested across ${critiques.filter((c) => c.success).length} solution-specific peer critiques and refined in Round 3. Proposal #${recommendedIdx} (${recommendedProp?.agentName ?? 'lead'}) combined with the strongest peer improvements provides the clearest path forward.`,
    recommendedApproach,
    recommendedProposalIndex: recommendedIdx,
    hybridHighlights,
  };
}

function formatCouncilOutput(input: {
  id: string;
  problem: string;
  proposals: CouncilProposal[];
  critiques: CouncilCritique[];
  refinements: CouncilRefinement[];
  verdict: CouncilVerdict;
  unavailable: string[];
}): string {
  const sections: string[] = [
    `${colors.brand}✦ ${colors.bold}Multi-Agent Solution Debate Council${colors.reset} ${colors.dim}(${input.proposals.length} solutions debated across 3 rounds)${colors.reset}`,
  ];
  if (input.unavailable.length > 0) {
    sections.push(`  ${colors.yellow}⚠ Skipped unavailable:${colors.reset} ${input.unavailable.join(', ')}`);
  }

  for (const prop of input.proposals) {
    const secs = `${(prop.durationMs / 1000).toFixed(1)}s`;
    const isRec = input.verdict.recommendedProposalIndex === prop.index;
    const recBadge = isRec ? ` ${colors.green}${colors.bold}★ recommended base${colors.reset}` : '';
    const block: string[] = [
      `${colors.brand}${colors.bold}Solution #${prop.index} — ${prop.agentName}${colors.reset} ${colors.dim}(${prop.agentId} · ${secs})${colors.reset}${recBadge}`,
      `  ${colors.cyan}Proposal:${colors.reset} ${firstMeaningfulLine(prop.content, 240)}`,
    ];

    const propCritiques = input.critiques.filter(
      (c) => c.targetProposalIndex === prop.index && c.success,
    );
    for (const c of propCritiques) {
      block.push(
        `  ${colors.yellow}↳ Critique (${c.criticAgentName}):${colors.reset} ${firstMeaningfulLine(c.content, 220)}`,
      );
    }

    const ref = input.refinements.find((r) => r.proposalIndex === prop.index && r.success);
    if (ref) {
      block.push(
        `  ${colors.green}↳ Refined (${ref.agentName}):${colors.reset} ${firstMeaningfulLine(ref.content, 240)}`,
      );
    }

    sections.push(block.join('\n'));
  }

  const verdictLines: string[] = [
    `${colors.brand}✦ ${colors.bold}Council Verdict${colors.reset}`,
    input.verdict.summary,
  ];
  if (input.verdict.hybridHighlights.length > 0) {
    verdictLines.push('', `${colors.bold}Key Takeaways & Merged Improvements:${colors.reset}`);
    for (const h of input.verdict.hybridHighlights) {
      verdictLines.push(`  • ${h}`);
    }
  }
  if (input.verdict.savedReportPath) {
    verdictLines.push(
      '',
      `  ${colors.dim}Full 3-round transcript saved to ${input.verdict.savedReportPath}${colors.reset}`,
    );
  }
  verdictLines.push(
    `  ${colors.dim}↵ Enter: implement recommended solution   ·   "blueprint" to create a Living Plan   ·   1..${input.proposals.length} to implement a specific proposal   ·   inspect <n> to read full thread   ·   /back to keep as reference${colors.reset}`,
  );
  sections.push(verdictLines.join('\n'));

  return sections.join(`\n\n${colors.darkGray}${'─'.repeat(60)}${colors.reset}\n\n`);
}

/** Formats the complete 3-round discussion thread for a single solution (`inspect <n>`). */
export function formatCouncilProposalThread(
  decision: PendingCouncilDecision,
  proposalIndex: number,
): string {
  const prop = decision.proposals.find((p) => p.index === proposalIndex);
  if (!prop) {
    return `${colors.red}✖ Solution #${proposalIndex} not found.${colors.reset} Available: 1..${decision.proposals.length}.`;
  }
  const lines: string[] = [
    `${colors.brand}✦ ${colors.bold}Full Thread — Solution #${prop.index} (${prop.agentName})${colors.reset}`,
    '',
    `${colors.cyan}${colors.bold}Round 1 — Initial Proposal:${colors.reset}`,
    prop.content,
  ];

  const propCritiques = decision.critiques.filter((c) => c.targetProposalIndex === prop.index && c.success);
  for (const c of propCritiques) {
    lines.push('', `${colors.yellow}${colors.bold}Round 2 — Critique by ${c.criticAgentName}:${colors.reset}`, c.content);
  }

  const ref = decision.refinements.find((r) => r.proposalIndex === prop.index && r.success);
  if (ref) {
    lines.push('', `${colors.green}${colors.bold}Round 3 — Refined Solution (${ref.agentName}):${colors.reset}`, ref.content);
  }

  lines.push(
    '',
    `  ${colors.dim}Type ${prop.index} to implement Solution #${prop.index}, Enter for Council Verdict, "blueprint" for Living Plan, or /back to close.${colors.reset}`,
  );
  return lines.join('\n');
}

/** Builds a concrete implementation goal from a Council Verdict or chosen proposal. */
export function buildCouncilHandoffGoal(
  decision: PendingCouncilDecision,
  choice: 'verdict' | number,
): string {
  if (typeof choice === 'number') {
    const prop = decision.proposals.find((p) => p.index === choice);
    const ref = decision.refinements.find((r) => r.proposalIndex === choice && r.success);
    const body = ref?.content || prop?.content || decision.verdict.recommendedApproach;
    return [
      `Implement Solution #${choice} (${prop?.agentName ?? 'selected'}) from the Solution Debate Council for: ${decision.problem}`,
      '',
      `Selected refined design:\n${body.slice(0, 4500)}`,
    ].join('\n');
  }

  return [
    `Implement the Solution Debate Council's recommended approach for: ${decision.problem}`,
    '',
    `Council Verdict:\n${decision.verdict.summary}`,
    '',
    `Recommended Design:\n${decision.verdict.recommendedApproach.slice(0, 4500)}`,
    decision.verdict.hybridHighlights.length > 0
      ? `\nKey merged improvements:\n${decision.verdict.hybridHighlights.map((h) => `- ${h}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
