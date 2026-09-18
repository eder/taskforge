import { AgentRegistry, AgentAdapter } from '@taskforge/agents';
import { RoleRequest } from './router-types.js';

export interface SelectedAgentAssignment {
  roleRequest: RoleRequest;
  agent: AgentAdapter;
}

export class AgentSelector {
  constructor(private registry: AgentRegistry) {}

  async selectAgents(roleRequests: RoleRequest[]): Promise<SelectedAgentAssignment[]> {
    const availableAdapters = this.registry.list();
    const results: SelectedAgentAssignment[] = [];
    const usedAgentIds = new Set<string>();

    for (const req of roleRequests) {
      let chosen: AgentAdapter | undefined;

      // 1. Try preferredAgent if ready and not yet used for this task (if multiple roles)
      if (req.preferredAgent) {
        const candidate = this.registry.get(req.preferredAgent);
        if (candidate && !usedAgentIds.has(candidate.id)) {
          const isReady = await candidate.detect();
          if (isReady) {
            chosen = candidate;
          }
        }
      }

      // 2. Try role-based heuristics if no preferred or preferred not available
      if (!chosen) {
        const candidates = availableAdapters.filter((a) => !usedAgentIds.has(a.id));
        for (const candidate of candidates) {
          const isReady = await candidate.detect();
          if (!isReady) continue;

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

      // 3. Fallback to any ready agent
      if (!chosen) {
        for (const candidate of availableAdapters) {
          if (await candidate.detect()) {
            chosen = candidate;
            break;
          }
        }
      }

      if (chosen) {
        usedAgentIds.add(chosen.id);
        results.push({
          roleRequest: req,
          agent: chosen,
        });
      }
    }

    return results;
  }
}
