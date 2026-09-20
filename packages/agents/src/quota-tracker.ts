export type AgentQuotaStatus =
  'ready' | 'quota_exhausted' | 'rate_limited' | 'not_installed' | 'auth_failed';

export interface AgentQuotaRecord {
  agentId: string;
  status: AgentQuotaStatus;
  reason?: string;
  recordedAt: number;
  resetAt?: number;
}

export class AgentQuotaTracker {
  private static instance: AgentQuotaTracker | undefined;
  private records: Map<string, AgentQuotaRecord> = new Map();

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
   * Evaluates agent execution output for rate limits, quota exhaustion, or auth failures.
   * Returns true if a quota, rate-limit, or auth issue was identified.
   */
  recordFailure(agentId: string, output: string): boolean {
    if (!output || typeof output !== 'string') return false;

    const lower = output.toLowerCase();
    const isAuthFailure =
      lower.includes('failed to authenticate') ||
      lower.includes('oauth session expired') ||
      lower.includes('authentication_failed') ||
      lower.includes('authentication failed') ||
      lower.includes('invalid api key') ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden');

    if (isAuthFailure) {
      this.records.set(agentId, {
        agentId,
        status: 'auth_failed',
        reason: 'authentication failed or session expired',
        recordedAt: Date.now(),
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
    if (atTimeMatch) {
      reason = `cooldown until ${atTimeMatch[1].trim()}`;
      resetAt = this.parseTimeTodayOrTomorrow(atTimeMatch[1].trim());
    } else {
      const inSecondsMatch = output.match(/try again in\s+([0-9]+)\s*(s|sec|seconds?)/i);
      if (inSecondsMatch) {
        const secs = parseInt(inSecondsMatch[1], 10);
        reason = `retry in ${secs}s`;
        resetAt = Date.now() + secs * 1000;
      } else {
        const inMinutesMatch = output.match(/try again in\s+([0-9]+)\s*(m|min|minutes?)/i);
        if (inMinutesMatch) {
          const mins = parseInt(inMinutesMatch[1], 10);
          reason = `retry in ${mins}m`;
          resetAt = Date.now() + mins * 60 * 1000;
        } else {
          // Default cooldown: 30 minutes for usage limit, 5 minutes for rate limit
          const defaultMinutes = isUsageLimit ? 30 : 5;
          reason = isUsageLimit ? 'usage limit reached' : 'rate limit reached';
          resetAt = Date.now() + defaultMinutes * 60 * 1000;
        }
      }
    }

    this.records.set(agentId, {
      agentId,
      status,
      reason,
      recordedAt: Date.now(),
      resetAt,
    });

    return true;
  }

  recordSuccess(agentId: string): void {
    this.records.delete(agentId);
  }

  setManualStatus(
    agentId: string,
    status: AgentQuotaStatus,
    reason?: string,
    cooldownMinutes = 15,
  ): void {
    if (status === 'ready' || status === 'not_installed') {
      this.records.delete(agentId);
      return;
    }

    this.records.set(agentId, {
      agentId,
      status,
      reason: reason ?? (status === 'quota_exhausted' ? 'quota limit reached' : 'rate limited'),
      recordedAt: Date.now(),
      resetAt: Date.now() + cooldownMinutes * 60 * 1000,
    });
  }

  getQuotaStatus(agentId: string): { status: AgentQuotaStatus; reason?: string; resetAt?: Date } {
    const record = this.records.get(agentId);
    if (!record) {
      return { status: 'ready' };
    }

    // Check if cooldown has expired
    if (record.resetAt && Date.now() >= record.resetAt) {
      this.records.delete(agentId);
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

  private parseTimeTodayOrTomorrow(timeStr: string): number {
    const now = new Date();
    const parts = timeStr.match(/([0-9]{1,2}):([0-9]{2})(?:\s*([AaPp][Mm]))?/);
    if (!parts) {
      return Date.now() + 30 * 60 * 1000; // default 30 min
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
