import { AgentAdapter } from './adapter-interface.js';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  AntigravityAdapter,
  CursorAdapter,
  AiderAdapter,
  OpenCodeAdapter,
  GooseAdapter,
  CliAdapterOptions,
} from './real-adapters.js';
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

type AgentConfigs = Record<
  string,
  {
    enabled?: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    passEnv?: string[];
  }
>;

interface HarnessDefinition {
  id: string;
  create: (options: CliAdapterOptions) => AgentAdapter;
  /** Registered even without an `agents.<id>` config entry. */
  builtIn: boolean;
}

const HARNESSES: HarnessDefinition[] = [
  { id: 'claude', create: (o) => new ClaudeCodeAdapter(o), builtIn: true },
  { id: 'codex', create: (o) => new CodexAdapter(o), builtIn: true },
  { id: 'agy', create: (o) => new AntigravityAdapter(o), builtIn: true },
  { id: 'cursor', create: (o) => new CursorAdapter(o), builtIn: false },
  { id: 'aider', create: (o) => new AiderAdapter(o), builtIn: false },
  { id: 'opencode', create: (o) => new OpenCodeAdapter(o), builtIn: false },
  { id: 'goose', create: (o) => new GooseAdapter(o), builtIn: false },
];

export class AgentRegistry {
  private adapters: Map<string, AgentAdapter> = new Map();

  constructor(registerDefaults: boolean = true, agentConfigs?: AgentConfigs) {
    if (!registerDefaults) return;

    for (const harness of HARNESSES) {
      const agentConfig = agentConfigs?.[harness.id];
      if (agentConfig?.enabled === false) continue;
      if (!harness.builtIn && !agentConfig) continue; // extended harnesses are opt-in

      const options: CliAdapterOptions = {};
      if (agentConfig?.command) options.binaryPath = agentConfig.command;
      if (agentConfig?.args && agentConfig.args.length > 0) options.defaultArgs = agentConfig.args;
      if (agentConfig?.env) options.env = agentConfig.env;
      if (agentConfig?.passEnv) options.passEnv = agentConfig.passEnv;
      this.register(harness.create(options));
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
