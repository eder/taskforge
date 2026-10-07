export type AgentQuotaStatus =
  | 'ready'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'not_installed'
  | 'auth_failed';

export type AgentAvailabilitySource = 'runtime' | 'manual';

export interface AgentQuotaRecord {
  agentId: string;
  status: AgentQuotaStatus;
  reason?: string;
  recordedAt: number;
  resetAt?: number;
  source?: AgentAvailabilitySource;
}

/**
 * Minimal persistence contract so the agents package does not depend on the
 * persistence package. AgentAvailabilityRepository satisfies this interface
 * structurally.
 */
export interface AgentQuotaStore {
  list(): Array<{
    agentId: string;
    status: string;
    reason?: string;
    recordedAt: number;
    resetAt?: number;
    source?: string;
  }>;
  upsert(record: {
    agentId: string;
    status: string;
    reason?: string;
    recordedAt: number;
    resetAt?: number;
    source: string;
  }): void;
  delete(agentId: string): void;
}

/**
 * An authentication failure may be a transient glitch or something the user has since fixed, and a
 * blocked agent is never scheduled again, so nothing would ever prove it healthy. Retry after this long.
 */
const AUTH_RETRY_MS = 30 * 60 * 1000;

/** Provider errors are at the end of a failed run; the start is the prompt and whatever the agent echoed. */
const AUTH_FAILURE_WINDOW_CHARS = 4000;

/**
 * Phrases that mean "you are not signed in / the key is not accepted". A bare "forbidden" or
 * "unauthorized" is not one: TaskForge's own task contract says `forbiddenChanges`, and agents quote
 * source code, so those words appear in healthy output. An HTTP status next to the word is required.
 */
const AUTH_FAILURE_PATTERNS = [
  /failed to authenticate/,
  /oauth session expired/,
  /authentication[_ ]failed/,
  /authentication_error/,
  /invalid[ _]api[ _-]?key/,
  /invalid x-api-key/,
  /incorrect api key/,
  /not logged in/,
  /please (?:log|sign) ?in/,
  /\b(?:401|403)\b[^\n]{0,40}\b(?:unauthori[sz]ed|forbidden)\b/,
  /\b(?:unauthori[sz]ed|forbidden)\b[^\n]{0,40}\b(?:401|403)\b/,
];

/** Exported for tests. */
export function looksLikeAuthFailure(output: string): boolean {
  const tail = output.slice(-AUTH_FAILURE_WINDOW_CHARS).toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(tail));
}

const PERSISTABLE_STATUSES = new Set<AgentQuotaStatus>([
  'quota_exhausted',
  'rate_limited',
  'auth_failed',
]);

export class AgentQuotaTracker {
  private static instance: AgentQuotaTracker | undefined;
  private records: Map<string, AgentQuotaRecord> = new Map();
  private store?: AgentQuotaStore;

  static getInstance(): AgentQuotaTracker {
    if (!AgentQuotaTracker.instance) {
      AgentQuotaTracker.instance = new AgentQuotaTracker();
    }
    return AgentQuotaTracker.instance;
  }

  static resetInstance(): void {
    AgentQuotaTracker.instance = undefined;
  }

  /**
   * Attach durable storage and hydrate previously learned provider state.
   * Reconfiguration is intentional: shells/tests can point the singleton at a
   * different TaskForge database without retaining state from another repo.
   */
  configureStore(store: AgentQuotaStore): void {
    this.store = store;
    this.records.clear();

    try {
      for (const persisted of store.list()) {
        if (!PERSISTABLE_STATUSES.has(persisted.status as AgentQuotaStatus)) {
          continue;
        }

        const record: AgentQuotaRecord = {
          agentId: persisted.agentId,
          status: persisted.status as AgentQuotaStatus,
          reason: persisted.reason,
          recordedAt: persisted.recordedAt,
          resetAt: persisted.resetAt,
          source: persisted.source === 'manual' ? 'manual' : 'runtime',
        };

        const expiry = this.expiresAt(record);
        if (expiry && Date.now() >= expiry) {
          // Cooldown is already over. Remove the durable OPEN circuit so the
          // next selection is the single real probe of the provider.
          this.safeDelete(record.agentId);
          continue;
        }

        this.records.set(record.agentId, record);
      }
    } catch {
      // Availability persistence must never prevent TaskForge from starting.
      // Runtime failures can still repopulate the in-memory circuit breaker.
    }
  }

  /**
   * Evaluates agent execution output for rate limits, quota exhaustion, or auth failures.
   * Returns true if a quota, rate-limit, or auth issue was identified.
   */
  recordFailure(agentId: string, output: string, observedAt: number = Date.now()): boolean {
    if (!output || typeof output !== 'string') return false;

    const lower = output.toLowerCase();
    const isAuthFailure = looksLikeAuthFailure(output);

    if (isAuthFailure) {
      this.setRecord({
        agentId,
        status: 'auth_failed',
        reason: 'authentication failed or session expired',
        recordedAt: observedAt,
        source: 'runtime',
      });
      return true;
    }

    const isUsageLimit =
      lower.includes('usage limit') ||
      lower.includes('upgrade to pro') ||
      lower.includes('purchase more credits') ||
      lower.includes('insufficient_quota') ||
      lower.includes('credit balance is too low') ||
      lower.includes('exceeded your current quota') ||
      lower.includes('quota reached') ||
      lower.includes('quota exceeded') ||
      lower.includes('resource_exhausted');

    const isRateLimit =
      lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('429');

    if (!isUsageLimit && !isRateLimit) {
      return false;
    }

    const status: AgentQuotaStatus = isUsageLimit ? 'quota_exhausted' : 'rate_limited';

    // Parse potential reset time: e.g. "try again at 1:42 PM" or "try again in 30 seconds"
    let resetAt: number | undefined;
    let reason = isUsageLimit ? 'quota limit reached' : 'rate limited';

    const atTimeMatch = output.match(/try again at\s+([0-9]{1,2}:[0-9]{2}(?:\s*[AaPp][Mm])?)/i);
    // Google Antigravity/Gemini's own format: "Resets in 59h30m58s." (hours/minutes/seconds,
    // any subset present). Must be checked before the generic "try again in N seconds/minutes"
    // patterns below, since a bare "Xh" cooldown would otherwise fall through to the 30-minute
    // default and TaskForge would re-select the agent hours before its quota actually resets.
    const resetsInMatch = output.match(
      /resets?\s+in\s+(?:([0-9]+)\s*h)?(?:([0-9]+)\s*m)?(?:([0-9]+)\s*s)?/i,
    );
    const hasResetsInDuration =
      resetsInMatch && (resetsInMatch[1] || resetsInMatch[2] || resetsInMatch[3]);

    if (atTimeMatch) {
      reason = `cooldown until ${atTimeMatch[1].trim()}`;
      resetAt = this.parseTimeTodayOrTomorrow(atTimeMatch[1].trim(), observedAt);
    } else if (hasResetsInDuration) {
      const hours = parseInt(resetsInMatch![1] || '0', 10);
      const minutes = parseInt(resetsInMatch![2] || '0', 10);
      const seconds = parseInt(resetsInMatch![3] || '0', 10);
      const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
      reason = `resets in ${resetsInMatch![0].replace(/resets?\s+in\s+/i, '').trim()}`;
      resetAt = observedAt + totalMs;
    } else {
      const inSecondsMatch = output.match(/try again in\s+([0-9]+)\s*(s|sec|seconds?)/i);
      if (inSecondsMatch) {
        const secs = parseInt(inSecondsMatch[1], 10);
        reason = `retry in ${secs}s`;
        resetAt = observedAt + secs * 1000;
      } else {
        const inMinutesMatch = output.match(/try again in\s+([0-9]+)\s*(m|min|minutes?)/i);
        if (inMinutesMatch) {
          const mins = parseInt(inMinutesMatch[1], 10);
          reason = `retry in ${mins}m`;
          resetAt = observedAt + mins * 60 * 1000;
        } else {
          // Default cooldown: 30 minutes for usage limit, 5 minutes for rate limit
          const defaultMinutes = isUsageLimit ? 30 : 5;
          reason = isUsageLimit ? 'usage limit reached' : 'rate limit reached';
          resetAt = observedAt + defaultMinutes * 60 * 1000;
        }
      }
    }

    this.setRecord({
      agentId,
      status,
      reason,
      recordedAt: observedAt,
      resetAt,
      source: 'runtime',
    });

    return true;
  }

  recordSuccess(agentId: string): void {
    this.records.delete(agentId);
    this.safeDelete(agentId);
  }

  setManualStatus(
    agentId: string,
    status: AgentQuotaStatus,
    reason?: string,
    cooldownMinutes = 15,
  ): void {
    if (status === 'ready' || status === 'not_installed') {
      this.records.delete(agentId);
      this.safeDelete(agentId);
      return;
    }

    this.setRecord({
      agentId,
      status,
      reason: reason ?? (status === 'quota_exhausted' ? 'quota limit reached' : 'rate limited'),
      recordedAt: Date.now(),
      resetAt: status === 'auth_failed' ? undefined : Date.now() + cooldownMinutes * 60 * 1000,
      source: 'manual',
    });
  }

  /** When a record stops blocking: its reset time, or for a runtime auth failure the retry delay. */
  private expiresAt(record: AgentQuotaRecord): number | undefined {
    if (record.resetAt) return record.resetAt;
    if (record.status === 'auth_failed' && record.source !== 'manual') return record.recordedAt + AUTH_RETRY_MS;
    return undefined;
  }

  /**
   * The agent's own sign-in check says it is signed in, so a recorded authentication failure is stale.
   * A failure the user set by hand is left alone.
   */
  clearAuthFailure(agentId: string): void {
    const record = this.records.get(agentId);
    if (record?.status === 'auth_failed' && record.source !== 'manual') {
      this.records.delete(agentId);
      this.safeDelete(agentId);
    }
  }

  getQuotaStatus(agentId: string): { status: AgentQuotaStatus; reason?: string; resetAt?: Date } {
    const record = this.records.get(agentId);
    if (!record) {
      return { status: 'ready' };
    }

    // OPEN circuit cooldown expired. Forget the block and let the next actual
    // assignment act as the provider probe; success keeps it READY, another
    // quota failure re-opens the circuit with the provider's new reset time.
    const expiry = this.expiresAt(record);
    if (expiry && Date.now() >= expiry) {
      this.records.delete(agentId);
      this.safeDelete(agentId);
      return { status: 'ready' };
    }

    return {
      status: record.status,
      reason: record.reason,
      resetAt: record.resetAt ? new Date(record.resetAt) : undefined,
    };
  }

  isAvailable(agentId: string): boolean {
    return this.getQuotaStatus(agentId).status === 'ready';
  }

  private setRecord(record: AgentQuotaRecord): void {
    this.records.set(record.agentId, record);
    if (!PERSISTABLE_STATUSES.has(record.status)) return;

    try {
      this.store?.upsert({
        agentId: record.agentId,
        status: record.status,
        reason: record.reason,
        recordedAt: record.recordedAt,
        resetAt: record.resetAt,
        source: record.source ?? 'runtime',
      });
    } catch {
      // Persistence is best-effort; the in-memory circuit remains active.
    }
  }

  private safeDelete(agentId: string): void {
    try {
      this.store?.delete(agentId);
    } catch {
      // Best-effort cleanup only.
    }
  }

  private parseTimeTodayOrTomorrow(timeStr: string, observedAt: number = Date.now()): number {
    const now = new Date(observedAt);
    const parts = timeStr.match(/([0-9]{1,2}):([0-9]{2})(?:\s*([AaPp][Mm]))?/);
    if (!parts) {
      return observedAt + 30 * 60 * 1000; // default 30 min
    }

    let hours = parseInt(parts[1], 10);
    const minutes = parseInt(parts[2], 10);
    const ampm = parts[3]?.toUpperCase();

    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }
}
