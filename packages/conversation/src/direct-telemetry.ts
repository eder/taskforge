import type { TaskForgeDatabase } from '@taskforge/persistence';
import { colors } from './theme.js';

export type DirectTurnCategory = 'direct' | 'pipeline' | 'debate' | 'council' | 'compete' | 'tdd';

export interface DirectTelemetryRecord {
  timestamp: string;
  agentId: string;
  agentName: string;
  category: DirectTurnCategory;
  specialty: string;
  success: boolean;
  durationMs: number;
  tokensUsed: number;
  estimatedCostUsd: number;
}

export interface DirectAgentSummary {
  agentId: string;
  agentName: string;
  turns: number;
  successes: number;
  successRate: number;
  totalTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

const TELEMETRY_STATE_KEY = 'direct_telemetry_log';
const MAX_RECORDS = 500;

/** Rough per-1K-token blended rate fallback when provider does not report exact USD. */
const BLENDED_USD_PER_1K: Record<string, number> = {
  claude: 0.006,
  codex: 0.004,
  agy: 0.0025,
};

export function estimateDirectTurnCostUsd(agentId: string, tokensUsed: number): number {
  if (!tokensUsed || tokensUsed <= 0) return 0;
  const rate = BLENDED_USD_PER_1K[agentId] ?? 0.004;
  return Number(((tokensUsed / 1000) * rate).toFixed(4));
}

export function inferTaskSpecialty(prompt: string, files: string[] = []): string {
  const joined = `${prompt} ${files.join(' ')}`.toLowerCase();
  if (/\b(?:test|spec|vitest|jest|pytest|tdd|assert)\b|\.(?:test|spec)\.[a-z]+/.test(joined)) {
    return 'testing';
  }
  if (/\.(?:py)\b|\b(?:python|pytest|fastapi|django|pydantic)\b/.test(joined)) {
    return 'python';
  }
  if (/\.(?:rs)\b|\b(?:rust|cargo|tokio|axum)\b/.test(joined)) {
    return 'rust';
  }
  if (/\.(?:go)\b|\b(?:golang|goroutine)\b/.test(joined)) {
    return 'go';
  }
  if (/\.(?:tsx|jsx|css|html|vue|svelte)\b|\b(?:react|next\.?js|frontend|ui|css|component)\b/.test(joined)) {
    return 'frontend';
  }
  if (/\b(?:architect\w*|arquitet\w*|design|council|migrat\w*|schema|security|seguran\w*)\b/.test(joined)) {
    return 'architecture';
  }
  if (/\.(?:ts|js|mjs|cjs)\b|\b(?:typescript|node\.?js|pnpm)\b/.test(joined)) {
    return 'typescript';
  }
  if (/\b(?:bug|erro|error|fix|corrig\w*|stack\s*trace|traceback|crash)\b/.test(joined)) {
    return 'debugging';
  }
  return 'general';
}

/**
 * Lightweight SQLite-backed telemetry store (`session_state`) for Direct Mode,
 * Pipelines, Debates, Councils, and TDD turns so `/cost`, `/stats`, and
 * specialty-aware routing have unified visibility across ALL work done in `tf`.
 */
export class DirectTelemetryStore {
  private records: DirectTelemetryRecord[] = [];

  constructor(private readonly db?: TaskForgeDatabase) {
    this.hydrate();
  }

  private hydrate(): void {
    if (!this.db) return;
    try {
      const row = this.db
        .prepare('SELECT value FROM session_state WHERE key = ?')
        .get(TELEMETRY_STATE_KEY) as { value: string } | undefined;
      if (!row) return;
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) {
        this.records = parsed.slice(-MAX_RECORDS);
      }
    } catch {
      // ignore corrupted/unavailable table
    }
  }

  private persist(): void {
    if (!this.db) return;
    try {
      const iso = new Date().toISOString();
      this.db
        .prepare(
          'INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .run(TELEMETRY_STATE_KEY, JSON.stringify(this.records.slice(-MAX_RECORDS)), iso);
    } catch {
      // best-effort
    }
  }

  public record(input: {
    agentId: string;
    agentName: string;
    category: DirectTurnCategory;
    prompt?: string;
    files?: string[];
    success: boolean;
    durationMs: number;
    tokensUsed?: number;
  }): void {
    const tokens = Math.max(0, Math.round(input.tokensUsed ?? 0));
    const rec: DirectTelemetryRecord = {
      timestamp: new Date().toISOString(),
      agentId: input.agentId,
      agentName: input.agentName,
      category: input.category,
      specialty: inferTaskSpecialty(input.prompt ?? '', input.files ?? []),
      success: input.success,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      tokensUsed: tokens,
      estimatedCostUsd: estimateDirectTurnCostUsd(input.agentId, tokens),
    };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }
    this.persist();
  }

  public list(): readonly DirectTelemetryRecord[] {
    return this.records;
  }

  public getAgentSummaries(): DirectAgentSummary[] {
    const byAgent = new Map<string, DirectTelemetryRecord[]>();
    for (const r of this.records) {
      const list = byAgent.get(r.agentId) ?? [];
      list.push(r);
      byAgent.set(r.agentId, list);
    }
    const out: DirectAgentSummary[] = [];
    for (const [agentId, list] of byAgent.entries()) {
      const successes = list.filter((r) => r.success).length;
      const totalTokens = list.reduce((s, r) => s + r.tokensUsed, 0);
      const totalCostUsd = list.reduce((s, r) => s + r.estimatedCostUsd, 0);
      const totalMs = list.reduce((s, r) => s + r.durationMs, 0);
      out.push({
        agentId,
        agentName: list[list.length - 1]?.agentName ?? agentId,
        turns: list.length,
        successes,
        successRate: list.length > 0 ? successes / list.length : 0,
        totalTokens,
        totalCostUsd: Number(totalCostUsd.toFixed(4)),
        avgDurationMs: list.length > 0 ? Math.round(totalMs / list.length) : 0,
      });
    }
    return out.sort((a, b) => b.turns - a.turns);
  }

  public formatCostSection(): string | undefined {
    if (this.records.length === 0) return undefined;
    const totalTurns = this.records.length;
    const totalTokens = this.records.reduce((s, r) => s + r.tokensUsed, 0);
    const totalCost = this.records.reduce((s, r) => s + r.estimatedCostUsd, 0);
    const summaries = this.getAgentSummaries();

    const lines: string[] = [
      `${colors.brand}✦ ${colors.bold}Direct Mode & Council Telemetry${colors.reset} ${colors.dim}(${totalTurns} turn${totalTurns === 1 ? '' : 's'})${colors.reset}`,
      `  Total tokens: ${colors.bold}${totalTokens.toLocaleString('en-US')}${colors.reset}  ·  Est. cost: ${colors.cyan}~$${totalCost.toFixed(4)}${colors.reset}`,
    ];
    for (const s of summaries) {
      const pct = Math.round(s.successRate * 100);
      const secs = (s.avgDurationMs / 1000).toFixed(1);
      lines.push(
        `  • ${colors.bold}${s.agentName}${colors.reset} (${s.agentId}): ${s.turns} turns · ${pct}% ok · avg ${secs}s · ${s.totalTokens.toLocaleString('en-US')} tokens (~$${s.totalCostUsd.toFixed(4)})`,
      );
    }
    return lines.join('\n');
  }
}
