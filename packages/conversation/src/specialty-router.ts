import type { TaskForgeDatabase } from '@taskforge/persistence';
import { colors } from './theme.js';
import { inferTaskSpecialty, type DirectTelemetryStore } from './direct-telemetry.js';

export interface AgentSpecialtyMetric {
  agentId: string;
  specialty: string;
  samples: number;
  successRate: number;
  avgDurationMs: number;
  score: number;
}

/**
 * Learns per-agent, per-domain specialty performance locally from SQLite
 * orchestrated executions + Direct Mode telemetry, feeding data-driven
 * preferences into `@smart` / `auto` routing and `/stats`.
 */
export class SpecialtyRouter {
  constructor(
    private readonly db?: TaskForgeDatabase,
    private readonly directTelemetry?: DirectTelemetryStore,
    private readonly minSamples = 3,
  ) {}

  public computeSpecialtyMetrics(): AgentSpecialtyMetric[] {
    const buckets = new Map<
      string,
      { agentId: string; specialty: string; samples: number; successes: number; totalMs: number }
    >();

    const addSample = (agentId: string, specialty: string, success: boolean, durationMs: number) => {
      const key = `${agentId}::${specialty}`;
      const cur = buckets.get(key) ?? {
        agentId,
        specialty,
        samples: 0,
        successes: 0,
        totalMs: 0,
      };
      cur.samples += 1;
      if (success) cur.successes += 1;
      cur.totalMs += Math.max(0, durationMs);
      buckets.set(key, cur);
    };

    // 1. Direct Mode / Pipeline / Council telemetry samples
    for (const rec of this.directTelemetry?.list() ?? []) {
      addSample(rec.agentId, rec.specialty, rec.success, rec.durationMs);
    }

    // 2. Historical orchestrated executions from SQLite
    if (this.db) {
      try {
        const rows = this.db
          .prepare(
            `SELECT e.agent_id, e.status, e.exit_code,
                    (strftime('%s', e.finished_at) - strftime('%s', e.started_at)) * 1000 as duration_ms,
                    t.title, t.type
             FROM executions e
             JOIN tasks t ON e.task_id = t.id
             WHERE e.finished_at IS NOT NULL`,
          )
          .all() as Array<{
          agent_id: string;
          status: string;
          exit_code: number | null;
          duration_ms: number | null;
          title: string;
          type: string;
        }>;
        for (const row of rows) {
          const specialty = inferTaskSpecialty(`${row.title} ${row.type}`);
          const ok = row.status === 'success' || row.exit_code === 0;
          addSample(row.agent_id, specialty, ok, row.duration_ms ?? 0);
        }
      } catch {
        // Ignore if schema is minimal/empty
      }
    }

    const metrics: AgentSpecialtyMetric[] = [];
    for (const b of buckets.values()) {
      const successRate = b.samples > 0 ? b.successes / b.samples : 0;
      const avgDurationMs = b.samples > 0 ? Math.round(b.totalMs / b.samples) : 0;
      const speedBonus = Math.max(0, 0.12 - (avgDurationMs / 60_000) * 0.04);
      const score = Number(Math.max(0, Math.min(1, successRate * 0.88 + speedBonus)).toFixed(3));
      metrics.push({
        agentId: b.agentId,
        specialty: b.specialty,
        samples: b.samples,
        successRate: Number(successRate.toFixed(3)),
        avgDurationMs,
        score,
      });
    }

    return metrics.sort((a, b) => b.score - a.score || b.samples - a.samples);
  }

  /**
   * Returns a proven best agent for `(prompt, files)` when enough local evidence
   * (`samples >= minSamples`) exists for at least one candidate in `availableAgents`.
   */
  public recommendForTask(
    prompt: string,
    availableAgents: readonly string[],
    files: string[] = [],
  ): { agentId: string; specialty: string; reason: string } | undefined {
    const specialty = inferTaskSpecialty(prompt, files);
    const avail = new Set(availableAgents);
    const candidates = this.computeSpecialtyMetrics().filter(
      (m) => m.specialty === specialty && avail.has(m.agentId) && m.samples >= this.minSamples,
    );
    if (candidates.length === 0) return undefined;
    const winner = candidates[0];
    if (winner.successRate < 0.6) return undefined;
    return {
      agentId: winner.agentId,
      specialty,
      reason: `learned ${specialty} leader (${Math.round(winner.successRate * 100)}% over ${winner.samples} runs)`,
    };
  }

  public formatLearnedSpecialtiesSection(): string | undefined {
    const metrics = this.computeSpecialtyMetrics().filter((m) => m.samples >= 2);
    if (metrics.length === 0) return undefined;
    const lines = [`${colors.brand}✦ ${colors.bold}Learned Agent Specialties${colors.reset} ${colors.dim}(local SQLite history)${colors.reset}`];
    for (const m of metrics.slice(0, 8)) {
      const pct = Math.round(m.successRate * 100);
      const secs = (m.avgDurationMs / 1000).toFixed(1);
      lines.push(
        `  • ${colors.cyan}${m.specialty.padEnd(12)}${colors.reset} → ${colors.bold}${m.agentId}${colors.reset}  ${pct}% ok · avg ${secs}s · n=${m.samples} (score ${m.score.toFixed(2)})`,
      );
    }
    return lines.join('\n');
  }
}
