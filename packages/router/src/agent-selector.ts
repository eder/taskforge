import { AgentRegistry, AgentAdapter, AgentQuotaTracker } from '@taskforge/agents';
import { RoleRequest } from './router-types.js';

export interface SelectedAgentAssignment {
  roleRequest: RoleRequest;
  agent: AgentAdapter;
  /** True when this agent was already assigned to another role in the same selection call. */
  degraded?: boolean;
}

export interface AgentSelectionOptions {
  /** Agents that must not be considered for this selection attempt (e.g. failed providers). */
  excludeAgentIds?: Iterable<string>;
}

export class AgentSelector {
  constructor(private registry: AgentRegistry) {}

  async selectAgentForRole(
    roleRequest: RoleRequest,
    options: AgentSelectionOptions = {},
  ): Promise<SelectedAgentAssignment | undefined> {
    const selected = await this.selectAgents([roleRequest], options);
    return selected[0];
  }

  async selectAgents(
    roleRequests: RoleRequest[],
    options: AgentSelectionOptions = {},
  ): Promise<SelectedAgentAssignment[]> {
    const excluded = new Set(options.excludeAgentIds ?? []);
    const availableAdapters = this.registry.list().filter((a) => !excluded.has(a.id));
    const results: SelectedAgentAssignment[] = [];
    const usedAgentIds = new Set<string>();
    const quotaTracker = AgentQuotaTracker.getInstance();

    const eligible = async (candidate: AgentAdapter, req: RoleRequest): Promise<boolean> => {
      if (excluded.has(candidate.id)) return false;
      if (!(await candidate.detect())) return false;
      if (!quotaTracker.isAvailable(candidate.id)) return false;

      const caps = await candidate.capabilities();
      return req.requiredCapabilities.every((cap) => {
        if (cap === 'canWrite') return caps.canWrite;
        if (cap === 'canRead') return caps.canRead;
        if (cap === 'canExecute') return caps.canExecute;
        // Unknown capability names remain advisory for backward compatibility.
        return true;
      });
    };

    for (const req of roleRequests) {
      let chosen: AgentAdapter | undefined;

      // 1. Preferred agent, but only if it is actually available and capable.
      if (req.preferredAgent) {
        const candidate = this.registry.get(req.preferredAgent);
        if (
          candidate &&
          !usedAgentIds.has(candidate.id) &&
          (await eligible(candidate, req))
        ) {
          chosen = candidate;
        }
      }

      // 2. Prefer an unused, healthy, capability-compatible agent.
      if (!chosen) {
        for (const candidate of availableAdapters.filter((a) => !usedAgentIds.has(a.id))) {
          if (await eligible(candidate, req)) {
            chosen = candidate;
            break;
          }
        }
      }

      let degraded = false;

      // 3. Degraded fallback: reuse a healthy agent already covering another role.
      // Never resurrect an agent that quota/auth tracking has marked unavailable.
      if (!chosen) {
        for (const candidate of availableAdapters) {
          if (await eligible(candidate, req)) {
            chosen = candidate;
            degraded = usedAgentIds.has(candidate.id);
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
