import { AgentAdapter } from './adapter-interface.js';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  AntigravityAdapter,
  GeminiCliAdapter,
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

export class AgentRegistry {
  private adapters: Map<string, AgentAdapter> = new Map();

  constructor() {
    // Register default known harnesses
    this.register(new ClaudeCodeAdapter());
    this.register(new CodexAdapter());
    this.register(new AntigravityAdapter());
    this.register(new GeminiCliAdapter());
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
