import { AgentAdapter } from './adapter-interface.js';
import { ClaudeCodeAdapter, CodexAdapter, GeminiCliAdapter } from './real-adapters.js';

export interface AgentDetectionReport {
  id: string;
  name: string;
  ready: boolean;
}

export class AgentDetector {
  public static async detect(adapters: AgentAdapter[]): Promise<AgentDetectionReport[]> {
    const results = await Promise.all(
      adapters.map(async (adapter) => {
        const ready = await adapter.detect();
        return {
          id: adapter.id,
          name: adapter.name,
          ready,
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
