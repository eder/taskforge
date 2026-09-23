import { AgentRegistry, AgentAdapter, AgentQuotaTracker } from '@taskforge/agents';
import { RoleRequest } from './router-types.js';
import { AgentFitScorer } from './agent-fit.js';

export interface SelectedAgentAssignment {
  roleRequest: RoleRequest;
  agent: AgentAdapter;
  /** True when this agent was already assigned to another role in the same selection call. */
  degraded?: boolean;
  /** Why this harness was selected after availability/capability filtering. */
  selectionReason?: string;
  /** Deterministic task-agent fit score. Fairness is used only among equal top scores. */
  fitScore?: number;
}

export interface AgentSelectionStats {
  agentId: string;
  totalAssignments: number;
  roleAssignments: number;
  lastAssignedAt?: string;
}

export interface AgentSelectionHistory {
  getAgentSelectionStats(agentId: string, role: string): AgentSelectionStats;
}

export interface AgentSelectorOptions {
  selectionHistory?: AgentSelectionHistory;
}

export interface AgentSelectionContext {
  /**
   * Stable task/repository identity used only to break exact fairness ties.
   * Rendezvous hashing makes the outcome independent of registry insertion order.
   */
  selectionKey?: string;
  /** Deterministic repository policy: only these agents may be selected. */
  allowedAgentIds?: Set<string>;
}

export interface ReplacementSelectionOptions extends AgentSelectionContext {
  excludeAgentIds?: Set<string>;
}

export class AgentSelector {
  constructor(
    private registry: AgentRegistry,
    private options: AgentSelectorOptions = {},
  ) {}

  async listAvailableAgentIds(): Promise<string[]> {
    const quotaTracker = AgentQuotaTracker.getInstance();
    const available: string[] = [];

    for (const agent of this.registry.list()) {
      if (!quotaTracker.isAvailable(agent.id)) continue;
      if (!(await agent.detect())) continue;
      available.push(agent.id);
    }

    return available;
  }

  async selectAgents(
    roleRequests: RoleRequest[],
    context: AgentSelectionContext = {},
  ): Promise<SelectedAgentAssignment[]> {
    const results: SelectedAgentAssignment[] = [];
    const usedAgentIds = new Set<string>();

    for (const req of roleRequests) {
      // Degraded reuse (step 4 inside selectForRole) is intentionally allowed
      // to pick an agent already assigned to another role in this same call --
      // only `usedAgentIds` gates steps 1-3, never the degraded fallback.
      const selection = await this.selectForRole(req, usedAgentIds, new Set(), context);
      if (selection) {
        usedAgentIds.add(selection.agent.id);
        results.push(selection);
      }
    }

    return results;
  }

  /**
   * Selects a single replacement agent for one role -- used at runtime when
   * the agent originally staffed for that role failed with a recoverable
   * (provider/quota) error mid-run. `excludeAgentIds` must contain every
   * agent already tried for this role so the same run never retries the
   * same failed agent for the same role twice.
   */
  async selectAgentForRole(
    roleRequest: RoleRequest,
    options: ReplacementSelectionOptions = {},
  ): Promise<SelectedAgentAssignment | undefined> {
    const exclude = options.excludeAgentIds ?? new Set<string>();
    return this.selectForRole(roleRequest, exclude, exclude, options);
  }

  /**
   * Core eligibility pipeline shared by both entry points above.
   *
   * Explicit router preferences are authoritative when healthy. When no
   * preference is supplied, candidate ordering is NOT allowed to decide the
   * result. Eligible agents are ranked by persisted assignment history:
   *   1. task-agent fit for the requested role/objective
   *   2. fewest assignments for this role (fit tie only)
   *   3. fewest assignments overall
   *   4. least recently assigned
   *   5. rendezvous hash for an exact deterministic tie
   *
   * This prevents both registry insertion order and historical usage from
   * becoming the primary routing policy. Fairness is only a tie-breaker.
   */
  private async selectForRole(
    req: RoleRequest,
    exclude: Set<string>,
    degradedExclude: Set<string>,
    context: AgentSelectionContext,
  ): Promise<SelectedAgentAssignment | undefined> {
    const availableAdapters = this.registry.list();
    const quotaTracker = AgentQuotaTracker.getInstance();
    let chosen: AgentAdapter | undefined;
    let selectionReason: string | undefined;
    let fitScore: number | undefined;
    const policyAllows = (agentId: string): boolean =>
      context.allowedAgentIds === undefined || context.allowedAgentIds.has(agentId);

    // Rank capability-compatible candidates by current-task fit. An explicit
    // router preference is considered only among equally best-fit candidates;
    // it cannot force a materially worse harness for the assignment.
    {
      const capable: AgentAdapter[] = [];
      for (const candidate of availableAdapters.filter((a) => !exclude.has(a.id) && policyAllows(a.id))) {
        const isReady = await candidate.detect();
        if (!isReady || !quotaTracker.isAvailable(candidate.id)) continue;

        const caps = await candidate.capabilities();
        const meetsCaps = req.requiredCapabilities.every((cap) => {
          if (cap === 'canWrite') return caps.canWrite;
          if (cap === 'canRead') return caps.canRead;
          if (cap === 'canExecute') return caps.canExecute;
          return true;
        });

        if (meetsCaps) capable.push(candidate);
      }
      const fit = this.chooseBestFitCandidate(capable, req, context.selectionKey, req.preferredAgent);
      chosen = fit?.agent;
      selectionReason = fit?.reason;
      fitScore = fit?.score;
    }

    // 3. Fallback to any healthy, non-excluded agent, still using fair ranking.
    if (!chosen) {
      const healthy: AgentAdapter[] = [];
      for (const candidate of availableAdapters.filter((a) => !exclude.has(a.id) && policyAllows(a.id))) {
        if ((await candidate.detect()) && quotaTracker.isAvailable(candidate.id)) {
          healthy.push(candidate);
        }
      }
      const fit = this.chooseBestFitCandidate(healthy, req, context.selectionKey, req.preferredAgent);
      chosen = fit?.agent;
      selectionReason = fit?.reason;
      fitScore = fit?.score;
    }

    let degraded = false;

    // 4. Degraded fallback: reuse an agent already staffed on another role.
    // Quota remains authoritative and candidate ordering still cannot decide.
    if (!chosen) {
      const reusable: AgentAdapter[] = [];
      for (const candidate of availableAdapters) {
        if (degradedExclude.has(candidate.id) || !policyAllows(candidate.id)) continue;
        if ((await candidate.detect()) && quotaTracker.isAvailable(candidate.id)) {
          reusable.push(candidate);
        }
      }
      const fit = this.chooseBestFitCandidate(reusable, req, context.selectionKey, req.preferredAgent);
      chosen = fit?.agent;
      selectionReason = fit ? `degraded reuse; ${fit.reason}` : undefined;
      fitScore = fit?.score;
      degraded = Boolean(chosen);
    }

    if (!chosen) return undefined;

    return {
      roleRequest: req,
      agent: chosen,
      degraded: degraded || undefined,
      selectionReason,
      fitScore,
    };
  }

  private chooseBestFitCandidate(
    candidates: AgentAdapter[],
    req: RoleRequest,
    selectionKey?: string,
    preferredAgent?: string,
  ): { agent: AgentAdapter; score: number; reason: string } | undefined {
    if (candidates.length === 0) return undefined;

    const assessed = candidates.map((agent) => ({
      agent,
      fit: AgentFitScorer.assess(agent.id, req),
    }));
    const bestScore = Math.max(...assessed.map((item) => item.fit.score));
    const bestFit = assessed.filter((item) => item.fit.score === bestScore);

    const preferredBestFit =
      preferredAgent !== undefined
        ? bestFit.find((item) => item.agent.id === preferredAgent)
        : undefined;
    const chosen =
      preferredBestFit?.agent ??
      this.chooseFairCandidate(
        bestFit.map((item) => item.agent),
        req,
        selectionKey,
      );
    if (!chosen) return undefined;
    const assessment = bestFit.find((item) => item.agent.id === chosen.id)!.fit;
    return {
      agent: chosen,
      score: assessment.score,
      reason: preferredBestFit
        ? `best task fit; router preference broke an equal-fit tie: ${assessment.reason}`
        : `best task fit: ${assessment.reason}`,
    };
  }

  private chooseFairCandidate(
    candidates: AgentAdapter[],
    req: RoleRequest,
    selectionKey?: string,
  ): AgentAdapter | undefined {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    const history = this.options.selectionHistory;
    let finalists = [...candidates];

    if (history) {
      const ranked = finalists.map((agent) => ({
        agent,
        stats: history.getAgentSelectionStats(agent.id, req.role),
      }));

      const minRoleAssignments = Math.min(...ranked.map((item) => item.stats.roleAssignments));
      let tied = ranked.filter((item) => item.stats.roleAssignments === minRoleAssignments);

      const minTotalAssignments = Math.min(...tied.map((item) => item.stats.totalAssignments));
      tied = tied.filter((item) => item.stats.totalAssignments === minTotalAssignments);

      const oldestTimestamp = Math.min(
        ...tied.map((item) =>
          item.stats.lastAssignedAt ? Date.parse(item.stats.lastAssignedAt) || 0 : 0,
        ),
      );
      tied = tied.filter(
        (item) =>
          (item.stats.lastAssignedAt ? Date.parse(item.stats.lastAssignedAt) || 0 : 0) ===
          oldestTimestamp,
      );

      finalists = tied.map((item) => item.agent);
    }

    if (finalists.length === 1) return finalists[0];

    // Highest rendezvous score wins. Because every candidate is scored from its
    // id plus a stable task key, insertion order has no effect on the outcome.
    const key = selectionKey ?? `${req.role}:${req.objective}`;
    return finalists.reduce((best, candidate) =>
      this.rendezvousScore(key, candidate.id) > this.rendezvousScore(key, best.id)
        ? candidate
        : best,
    );
  }

  private rendezvousScore(key: string, agentId: string): number {
    const input = `${key}|${agentId}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }
}
