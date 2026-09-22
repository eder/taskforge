import { AgentRegistry, AgentAdapter, AgentQuotaTracker } from '@taskforge/agents';
import { RoleRequest } from './router-types.js';

export interface SelectedAgentAssignment {
  roleRequest: RoleRequest;
  agent: AgentAdapter;
  /** True when this agent was already assigned to another role in the same selection call. */
  degraded?: boolean;
}

export class AgentSelector {
  constructor(private registry: AgentRegistry) {}

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

  async selectAgents(roleRequests: RoleRequest[]): Promise<SelectedAgentAssignment[]> {
    const results: SelectedAgentAssignment[] = [];
    const usedAgentIds = new Set<string>();

    for (const req of roleRequests) {
      // Degraded reuse (step 4 inside selectForRole) is intentionally allowed
      // to pick an agent already staffed on another role in this same call --
      // only `usedAgentIds` gates steps 1-3, never the degraded fallback.
      const selection = await this.selectForRole(req, usedAgentIds, new Set());
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
    options: { excludeAgentIds?: Set<string> } = {},
  ): Promise<SelectedAgentAssignment | undefined> {
    const exclude = options.excludeAgentIds ?? new Set<string>();
    return this.selectForRole(roleRequest, exclude, exclude);
  }

  /**
   * Core eligibility pipeline shared by both entry points above. `exclude`
   * gates every step; `degradedExclude` additionally gates the final reuse
   * fallback (steps 1-3 always respect `exclude`; the degraded step also
   * respects `degradedExclude`, which callers can widen or narrow
   * independently of `exclude`).
   *
   * Every step -- including the two fallbacks -- checks
   * `quotaTracker.isAvailable()`. An agent the AgentQuotaTracker has marked
   * quota_exhausted/rate_limited/auth_failed is "detected" but not
   * "available", and must never be silently reintroduced by a fallback path.
   */
  private async selectForRole(
    req: RoleRequest,
    exclude: Set<string>,
    degradedExclude: Set<string>,
  ): Promise<SelectedAgentAssignment | undefined> {
    const availableAdapters = this.registry.list();
    const quotaTracker = AgentQuotaTracker.getInstance();
    let chosen: AgentAdapter | undefined;

    // 1. Try preferredAgent if ready, quota is available, and not excluded
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

    // 2. Try role-based capability match among ready, quota-available, non-excluded agents
    if (!chosen) {
      const candidates = availableAdapters.filter((a) => !exclude.has(a.id));
      for (const candidate of candidates) {
        const isReady = await candidate.detect();
        if (!isReady) continue;
        if (!quotaTracker.isAvailable(candidate.id)) continue;

        const caps = await candidate.capabilities();
        const meetsCaps = req.requiredCapabilities.every((cap) => {
          if (cap === 'canWrite') return caps.canWrite;
          if (cap === 'canRead') return caps.canRead;
          if (cap === 'canExecute') return caps.canExecute;
          return true;
        });

        if (meetsCaps) {
          chosen = candidate;
          break;
        }
      }
    }

    // 3. Fallback to any ready, non-excluded agent with available quota,
    // regardless of declared capabilities.
    if (!chosen) {
      for (const candidate of availableAdapters.filter((a) => !exclude.has(a.id))) {
        if ((await candidate.detect()) && quotaTracker.isAvailable(candidate.id)) {
          chosen = candidate;
          break;
        }
      }
    }

    let degraded = false;

    // 4. Degraded fallback: reuse an agent already staffed on another role
    // (or, for selectAgentForRole, simply any remaining eligible agent).
    // Reached only when no unused agent is available at all. Still
    // quota-gated: `detected != available`, so a provider the tracker marked
    // unavailable is never reintroduced here either.
    if (!chosen) {
      for (const candidate of availableAdapters) {
        if (degradedExclude.has(candidate.id)) continue;
        if ((await candidate.detect()) && quotaTracker.isAvailable(candidate.id)) {
          chosen = candidate;
          degraded = true;
          break;
        }
      }
    }

    if (!chosen) {
      return undefined;
    }

    return {
      roleRequest: req,
      agent: chosen,
      degraded: degraded || undefined,
    };
  }
}
