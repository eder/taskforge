import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type PeerMessageKind =
  | 'discovery'
  | 'contract_update'
  | 'warning'
  | 'question'
  | 'handoff';

export interface PeerMailboxMessage {
  id: string;
  seq: number;
  runId: string;
  fromTaskId: string;
  fromAgentId: string;
  /** Omit or '*' to broadcast to all sibling tasks in the run. */
  toTaskId?: string;
  kind: PeerMessageKind;
  subject: string;
  body: string;
  relatedFiles?: string[];
  timestamp: string;
}

export interface FileLease {
  filePath: string;
  ownerTaskId: string;
  ownerAgentId: string;
  acquiredAt: string;
  expiresAt: string;
}

/**
 * File-backed peer-to-peer mailbox & deterministic advisory file-lock broker
 * for concurrent multi-agent runs. Enables sibling agents working in parallel
 * worktrees to share discoveries, propose contract updates, and prevent
 * overlapping writes via deterministic file leases.
 */
export class PeerMailbox {
  private readonly mailboxFile: string;
  private readonly locksFile: string;

  constructor(
    repoRoot: string,
    private readonly runId: string,
  ) {
    const dir = path.join(repoRoot, '.taskforge', 'mailbox');
    fs.mkdirSync(dir, { recursive: true });
    this.mailboxFile = path.join(dir, `${runId}.jsonl`);
    this.locksFile = path.join(dir, `${runId}.locks.json`);
  }

  public postMessage(input: {
    fromTaskId: string;
    fromAgentId: string;
    toTaskId?: string;
    kind: PeerMessageKind;
    subject: string;
    body: string;
    relatedFiles?: string[];
  }): PeerMailboxMessage {
    const existing = this.readMessages();
    const msg: PeerMailboxMessage = {
      id: `pm-${randomUUID().slice(0, 8)}`,
      seq: existing.length + 1,
      runId: this.runId,
      fromTaskId: input.fromTaskId,
      fromAgentId: input.fromAgentId,
      toTaskId: input.toTaskId || '*',
      kind: input.kind,
      subject: input.subject.trim(),
      body: input.body.trim(),
      ...(input.relatedFiles?.length ? { relatedFiles: [...new Set(input.relatedFiles)] } : {}),
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(this.mailboxFile, `${JSON.stringify(msg)}\n`, 'utf8');
    return msg;
  }

  public readMessages(filter: { forTaskId?: string; sinceSeq?: number } = {}): PeerMailboxMessage[] {
    if (!fs.existsSync(this.mailboxFile)) return [];
    const raw = fs.readFileSync(this.mailboxFile, 'utf8');
    const out: PeerMailboxMessage[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as PeerMailboxMessage;
        if (filter.sinceSeq !== undefined && msg.seq <= filter.sinceSeq) continue;
        if (
          filter.forTaskId &&
          msg.toTaskId &&
          msg.toTaskId !== '*' &&
          msg.toTaskId !== filter.forTaskId &&
          msg.fromTaskId !== filter.forTaskId
        ) {
          continue;
        }
        out.push(msg);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }

  /** Formats unread peer messages into a compact prompt block for a sibling agent. */
  public formatInboxForPrompt(forTaskId: string, sinceSeq = 0): string | undefined {
    const msgs = this.readMessages({ forTaskId, sinceSeq }).filter((m) => m.fromTaskId !== forTaskId);
    if (msgs.length === 0) return undefined;
    const lines = ['Peer Agent Mailbox (live updates from sibling tasks in this run):'];
    for (const m of msgs.slice(-12)) {
      const files = m.relatedFiles?.length ? ` [${m.relatedFiles.join(', ')}]` : '';
      lines.push(
        `- #${m.seq} [${m.kind}] ${m.fromTaskId} (${m.fromAgentId})${files}: ${m.subject} — ${m.body.slice(0, 260)}`,
      );
    }
    return lines.join('\n');
  }

  private loadActiveLocks(nowMs = Date.now()): Record<string, FileLease> {
    if (!fs.existsSync(this.locksFile)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.locksFile, 'utf8')) as Record<string, FileLease>;
      const active: Record<string, FileLease> = {};
      for (const [k, lease] of Object.entries(parsed)) {
        if (new Date(lease.expiresAt).getTime() > nowMs) {
          active[k] = lease;
        }
      }
      return active;
    } catch {
      return {};
    }
  }

  private saveLocks(locks: Record<string, FileLease>): void {
    const temp = `${this.locksFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(locks, null, 2), 'utf8');
    fs.renameSync(temp, this.locksFile);
  }

  /**
   * Acquires deterministic advisory file leases for a task. If any file is
   * currently leased by a different task, returns `acquired: false` with the
   * conflicting leases so the scheduler/agent avoids silent collisions.
   */
  public acquireLocks(
    files: readonly string[],
    ownerTaskId: string,
    ownerAgentId: string,
    ttlMs = 15 * 60_000,
  ): { acquired: boolean; conflicts: FileLease[]; leases: FileLease[] } {
    const now = Date.now();
    const locks = this.loadActiveLocks(now);
    const normalized = [...new Set(files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')))];
    const conflicts: FileLease[] = [];

    for (const file of normalized) {
      const existing = locks[file];
      if (existing && existing.ownerTaskId !== ownerTaskId) {
        conflicts.push(existing);
      }
    }
    if (conflicts.length > 0) {
      return { acquired: false, conflicts, leases: [] };
    }

    const acquiredAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    const leases: FileLease[] = [];
    for (const file of normalized) {
      const lease: FileLease = {
        filePath: file,
        ownerTaskId,
        ownerAgentId,
        acquiredAt,
        expiresAt,
      };
      locks[file] = lease;
      leases.push(lease);
    }
    this.saveLocks(locks);
    return { acquired: true, conflicts: [], leases };
  }

  public releaseLocks(ownerTaskId: string): number {
    const locks = this.loadActiveLocks();
    let released = 0;
    for (const [file, lease] of Object.entries(locks)) {
      if (lease.ownerTaskId === ownerTaskId) {
        delete locks[file];
        released += 1;
      }
    }
    if (released > 0) this.saveLocks(locks);
    return released;
  }

  public listLocks(): FileLease[] {
    return Object.values(this.loadActiveLocks());
  }
}
