import type { AgentRegistry } from './agent-registry.js';
import { AgentQuotaTracker } from './quota-tracker.js';

/** Agents that can answer a structured question, best-verified first. */
const PREFERENCE = ['codex', 'claude'];

export interface AgentModelCallerOptions {
  /** Repository the agent reads to ground its answer. */
  cwd: string;
  timeoutMs: number;
  /** Receives the tokens the call used, so the cost is visible to whoever asked. */
  onUsage?: (usage: { agentId: string; tokens?: number }) => void;
}

/**
 * A model caller backed by the user's own coding agents, for when no OpenAI key is configured.
 * The first installed, in-quota agent that supports structured answers is used; if it fails, the
 * error reaches the caller (the planner then falls back) rather than silently spending another
 * agent's quota. Nothing here can change the repository: the CLIs run read-only.
 */
export function createAgentModelCaller(registry: AgentRegistry, options: AgentModelCallerOptions) {
  return async (
    messages: Array<{ role: string; content: string }>,
    schema: Record<string, unknown>,
  ): Promise<unknown> => {
    const quota = AgentQuotaTracker.getInstance();
    const candidates = registry
      .list()
      .filter((agent) => typeof agent.structuredQuery === 'function' && quota.isAvailable(agent.id))
      .sort((a, b) => rank(a.id) - rank(b.id));

    for (const agent of candidates) {
      if (!(await agent.detect())) continue;
      const prompt =
        messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n') +
        '\n\nYou may read files of this repository to ground the answer, but do not change anything. Reply with ONLY the JSON object that matches the schema.';
      const result = await agent.structuredQuery!({
        prompt,
        schema,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
      });
      options.onUsage?.({ agentId: agent.id, tokens: result.tokens });
      return result.value;
    }
    throw new Error('No installed agent that can answer structured questions is available');
  };
}

function rank(agentId: string): number {
  const index = PREFERENCE.indexOf(agentId);
  return index === -1 ? PREFERENCE.length : index;
}
