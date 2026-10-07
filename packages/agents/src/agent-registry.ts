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
import type { AuthStatus } from './auth-status.js';

export interface AgentDetectionReport {
  id: string;
  name: string;
  ready: boolean;
  quotaStatus?: AgentQuotaStatus;
  quotaReason?: string;
  resetAt?: Date;
  /** What the CLI itself says about being signed in (absent when it cannot say). */
  auth?: AuthStatus;
}

/** Status commands start a process each; the banner, doctor and every run all ask, so remember briefly. */
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, { at: number; status: AuthStatus }>();

async function authStatusOf(adapter: AgentAdapter): Promise<AuthStatus | undefined> {
  if (typeof adapter.authStatus !== 'function') return undefined;
  const cached = authCache.get(adapter.id);
  if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) return cached.status;
  const status = await adapter.authStatus();
  authCache.set(adapter.id, { at: Date.now(), status });
  return status;
}

export class AgentDetector {
  /** For tests: forget remembered sign-in checks. */
  public static resetAuthCache(): void {
    authCache.clear();
  }

  public static async detect(adapters: AgentAdapter[]): Promise<AgentDetectionReport[]> {
    const results = await Promise.all(
      adapters.map(async (adapter) => {
        const installed = await adapter.detect();
        const auth = installed ? await authStatusOf(adapter) : undefined;
        // The CLI says it is signed in: an authentication failure recorded earlier is stale.
        if (auth?.state === 'signed_in') AgentQuotaTracker.getInstance().clearAuthFailure(adapter.id);
        const quotaInfo = AgentQuotaTracker.getInstance().getQuotaStatus(adapter.id);
        // A CLI that says it is signed out will fail every task; report it as such rather than "ready".
        if (installed && quotaInfo.status === 'ready' && auth?.state === 'signed_out') {
          return {
            id: adapter.id,
            name: adapter.name,
            ready: false,
            quotaStatus: 'auth_failed' as AgentQuotaStatus,
            quotaReason: auth.signInCommand ? `not signed in; run "${auth.signInCommand}"` : 'not signed in',
            auth,
          };
        }
        const ready = installed && quotaInfo.status === 'ready';
        return {
          id: adapter.id,
          name: adapter.name,
          ready,
          quotaStatus: installed ? quotaInfo.status : 'not_installed',
          quotaReason: quotaInfo.reason,
          resetAt: quotaInfo.resetAt,
          auth,
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
