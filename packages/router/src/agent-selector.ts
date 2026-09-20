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

  async selectAgents(roleRequests: RoleRequest[]): Promise<SelectedAgentAssignment[]> {
    const availableAdapters = this.registry.list();
    const results: SelectedAgentAssignment[] = [];
    const usedAgentIds = new Set<string>();
    const quotaTracker = AgentQuotaTracker.getInstance();

    for (const req of roleRequests) {
      let chosen: AgentAdapter | undefined;

      // 1. Try preferredAgent if ready, quota is available, and not yet used
      if (req.preferredAgent) {
        const candidate = this.registry.get(req.preferredAgent);
        if (candidate && !usedAgentIds.has(candidate.id)) {
          const isReady = await candidate.detect();
          const hasQuota = quotaTracker.isAvailable(candidate.id);
          if (isReady && hasQuota) {
            chosen = candidate;
          }
        }
      }

      // 2. Try role-based heuristics if no preferred or preferred has no quota
      if (!chosen) {
        const candidates = availableAdapters.filter((a) => !usedAgentIds.has(a.id));
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

      // 3. Fallback to any ready, unused agent with available quota
      if (!chosen) {
        for (const candidate of availableAdapters.filter((a) => !usedAgentIds.has(a.id))) {
          if ((await candidate.detect()) && quotaTracker.isAvailable(candidate.id)) {
            chosen = candidate;
            break;
          }
        }
      }

      // 4. Last-ditch fallback to any detected, unused agent
      if (!chosen) {
        for (const candidate of availableAdapters.filter((a) => !usedAgentIds.has(a.id))) {
          if (await candidate.detect()) {
            chosen = candidate;
            break;
          }
        }
      }

      let degraded = false;

      // 5. Degraded fallback: only reached when no unused agent is available at all.
      // Reusing an agent already staffed on another role is made explicit via
      // `degraded: true` rather than silently duplicating it.
      if (!chosen) {
        for (const candidate of availableAdapters) {
          if (await candidate.detect()) {
            chosen = candidate;
            degraded = true;
            break;
          }
        }
      }

      if (chosen) {
        usedAgentIds.add(chosen.id);
        results.push({
          roleRequest: req,
          agent: chosen,
          degraded: degraded || undefined,
        });
      }
    }

    return results;
  }
}
