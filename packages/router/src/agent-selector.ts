import { AgentRegistry, AgentAdapter, AgentQuotaTracker } from '@taskforge/agents';
import { RoleRequest } from './router-types.js';

export interface SelectedAgentAssignment {
  roleRequest: RoleRequest;
  agent: AgentAdapter;
  /** True when this agent was already assigned to another role in the same selection call. */
  degraded?: boolean;
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
   *   1. fewest assignments for this role
   *   2. fewest assignments overall
   *   3. least recently assigned
   *   4. rendezvous hash for an exact deterministic tie
   *
   * This prevents the registry's insertion order (Claude, Codex, Antigravity)
   * from becoming an accidental routing policy.
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

    // 1. Respect an explicit router preference if it is actually usable.
    if (req.preferredAgent) {
      const candidate = this.registry.get(req.preferredAgent);
      if (candidate && !exclude.has(candidate.id)) {
        const isReady = await candidate.detect();
        const hasQuota = quotaTracker.isAvailable(candidate.id);
        if (isReady && hasQuota) {
          chosen = candidate;
        }
      }
    }

    // 2. Rank capability-compatible candidates fairly instead of taking the
    // first adapter in registry order.
    if (!chosen) {
      const capable: AgentAdapter[] = [];
      for (const candidate of availableAdapters.filter((a) => !exclude.has(a.id))) {
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
      chosen = this.chooseFairCandidate(capable, req, context.selectionKey);
    }

    // 3. Fallback to any healthy, non-excluded agent, still using fair ranking.
    if (!chosen) {
      const healthy: AgentAdapter[] = [];
      for (const candidate of availableAdapters.filter((a) => !exclude.has(a.id))) {
        if ((await candidate.detect()) && quotaTracker.isAvailable(candidate.id)) {
          healthy.push(candidate);
        }
      }
      chosen = this.chooseFairCandidate(healthy, req, context.selectionKey);
    }

    let degraded = false;

    // 4. Degraded fallback: reuse an agent already staffed on another role.
    // Quota remains authoritative and candidate ordering still cannot decide.
    if (!chosen) {
      const reusable: AgentAdapter[] = [];
      for (const candidate of availableAdapters) {
        if (degradedExclude.has(candidate.id)) continue;
        if ((await candidate.detect()) && quotaTracker.isAvailable(candidate.id)) {
          reusable.push(candidate);
        }
      }
      chosen = this.chooseFairCandidate(reusable, req, context.selectionKey);
      degraded = Boolean(chosen);
    }

    if (!chosen) return undefined;

    return {
      roleRequest: req,
      agent: chosen,
      degraded: degraded || undefined,
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
