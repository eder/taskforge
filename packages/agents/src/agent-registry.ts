import { AgentAdapter } from './adapter-interface.js';
import { ClaudeCodeAdapter, CodexAdapter, AntigravityAdapter } from './real-adapters.js';
import { AgentQuotaTracker, AgentQuotaStatus } from './quota-tracker.js';

export interface AgentDetectionReport {
  id: string;
  name: string;
  ready: boolean;
  quotaStatus?: AgentQuotaStatus;
  quotaReason?: string;
  resetAt?: Date;
}

export class AgentDetector {
  public static async detect(adapters: AgentAdapter[]): Promise<AgentDetectionReport[]> {
    const results = await Promise.all(
      adapters.map(async (adapter) => {
        const installed = await adapter.detect();
        const quotaInfo = AgentQuotaTracker.getInstance().getQuotaStatus(adapter.id);
        const ready = installed && quotaInfo.status === 'ready';
        return {
          id: adapter.id,
          name: adapter.name,
          ready,
          quotaStatus: installed ? quotaInfo.status : 'not_installed',
          quotaReason: quotaInfo.reason,
          resetAt: quotaInfo.resetAt,
        };
      }),
    );
    return results;
  }
}

export class AgentRegistry {
  private adapters: Map<string, AgentAdapter> = new Map();

  constructor(
    registerDefaults: boolean = true,
    agentConfigs?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>,
  ) {
    if (registerDefaults) {
      // Register default known harnesses
      const claudeOpts: import('./real-adapters.js').CliAdapterOptions = {};
      if (agentConfigs?.claude?.command) claudeOpts.binaryPath = agentConfigs.claude.command;
      if (agentConfigs?.claude?.args && agentConfigs.claude.args.length > 0) {
        claudeOpts.defaultArgs = agentConfigs.claude.args;
      }
      if (agentConfigs?.claude?.env) claudeOpts.env = agentConfigs.claude.env;
      this.register(new ClaudeCodeAdapter(claudeOpts));

      const codexOpts: import('./real-adapters.js').CliAdapterOptions = {};
      if (agentConfigs?.codex?.command) codexOpts.binaryPath = agentConfigs.codex.command;
      if (agentConfigs?.codex?.args && agentConfigs.codex.args.length > 0) {
        codexOpts.defaultArgs = agentConfigs.codex.args;
      }
      if (agentConfigs?.codex?.env) codexOpts.env = agentConfigs.codex.env;
      this.register(new CodexAdapter(codexOpts));

      const agyOpts: import('./real-adapters.js').CliAdapterOptions = {};
      if (agentConfigs?.agy?.command) agyOpts.binaryPath = agentConfigs.agy.command;
      if (agentConfigs?.agy?.args && agentConfigs.agy.args.length > 0) {
        agyOpts.defaultArgs = agentConfigs.agy.args;
      }
      if (agentConfigs?.agy?.env) agyOpts.env = agentConfigs.agy.env;
      this.register(new AntigravityAdapter(agyOpts));
    }
  }

  clear(): void {
    this.adapters.clear();
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }
}
