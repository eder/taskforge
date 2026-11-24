import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { colors } from './theme.js';

export interface ScheduledAutomation {
  id: string;
  schedule: string;
  intervalMs: number;
  command: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastOutputPreview?: string;
  nextRunAt: string;
}

export interface DaemonState {
  pid: number;
  repoRoot: string;
  startedAt: string;
  uiUrl?: string;
}

const SCHEDULES_FILE = path.join('.taskforge', 'schedules.json');
const DAEMON_FILE = path.join('.taskforge', 'daemon.json');

/**
 * Parses human-friendly schedule intervals (`every 15m`, `every 2h`, `every 1d`,
 * `30m`, `6h`, `daily`) into milliseconds. Returns `undefined` for invalid specs.
 */
export function parseScheduleIntervalMs(spec: string): number | undefined {
  const cleaned = spec.trim().toLowerCase().replace(/^every\s+/, '');
  if (cleaned === 'hourly') return 60 * 60_000;
  if (cleaned === 'daily' || cleaned === 'nightly') return 24 * 60 * 60_000;
  if (cleaned === 'weekly') return 7 * 24 * 60 * 60_000;

  const m = /^(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/.exec(cleaned);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2];
  if (unit === 's' || unit === 'sec') return Math.max(10_000, n * 1000);
  if (unit === 'm' || unit === 'min') return n * 60_000;
  if (unit === 'h' || unit === 'hr') return n * 60 * 60_000;
  if (unit === 'd' || unit === 'day') return n * 24 * 60 * 60_000;
  return undefined;
}

/**
 * Persists recurring scheduled automations in `.taskforge/schedules.json`
 * (e.g. nightly security audits, CI health checks, flaky-test hunters).
 */
export class ScheduleStore {
  private readonly filePath: string;

  constructor(private readonly repoRoot: string) {
    this.filePath = path.join(repoRoot, SCHEDULES_FILE);
  }

  public list(): ScheduledAutomation[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? (parsed as ScheduledAutomation[]) : [];
    } catch {
      return [];
    }
  }

  private save(items: ScheduledAutomation[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(temp, this.filePath);
  }

  public add(schedule: string, command: string, nowMs = Date.now()): ScheduledAutomation {
    const intervalMs = parseScheduleIntervalMs(schedule);
    if (!intervalMs) {
      throw new Error(`Invalid schedule "${schedule}". Use e.g. "30m", "6h", "daily", or "every 2h".`);
    }
    const items = this.list();
    const job: ScheduledAutomation = {
      id: `sch-${randomUUID().slice(0, 6)}`,
      schedule: schedule.trim(),
      intervalMs,
      command: command.trim(),
      enabled: true,
      createdAt: new Date(nowMs).toISOString(),
      nextRunAt: new Date(nowMs + intervalMs).toISOString(),
    };
    items.push(job);
    this.save(items);
    return job;
  }

  public remove(id: string): boolean {
    const items = this.list();
    const next = items.filter((j) => j.id !== id);
    if (next.length === items.length) return false;
    this.save(next);
    return true;
  }

  public getDueJobs(nowMs = Date.now()): ScheduledAutomation[] {
    return this.list().filter(
      (j) => j.enabled && new Date(j.nextRunAt).getTime() <= nowMs,
    );
  }

  public markExecuted(
    id: string,
    status: 'ok' | 'error',
    outputPreview: string,
    nowMs = Date.now(),
  ): void {
    const items = this.list().map((j) =>
      j.id === id
        ? {
            ...j,
            lastRunAt: new Date(nowMs).toISOString(),
            lastStatus: status,
            lastOutputPreview: outputPreview.slice(0, 300),
            nextRunAt: new Date(nowMs + j.intervalMs).toISOString(),
          }
        : j,
    );
    this.save(items);
  }

  public formatList(): string {
    const items = this.list();
    if (items.length === 0) {
      return [
        `${colors.dim}No scheduled automations configured (.taskforge/schedules.json).${colors.reset}`,
        `  ${colors.dim}Add one with: /schedule add 6h @codex verifica vulnerabilidades ou testes flaky${colors.reset}`,
      ].join('\n');
    }
    const lines = [
      `${colors.brand}✦ ${colors.bold}Scheduled Automations${colors.reset} ${colors.dim}(${items.length} configured)${colors.reset}`,
    ];
    for (const j of items) {
      const statusBadge =
        j.lastStatus === 'ok'
          ? `${colors.green}✔${colors.reset}`
          : j.lastStatus === 'error'
            ? `${colors.red}✖${colors.reset}`
            : `${colors.dim}○${colors.reset}`;
      lines.push(
        `  ${statusBadge} ${colors.cyan}${j.id}${colors.reset} ${colors.bold}${j.schedule}${colors.reset} — ${j.command.slice(0, 75)} ${colors.dim}(next: ${j.nextRunAt.slice(0, 16)})${colors.reset}`,
      );
    }
    lines.push(
      `  ${colors.dim}Commands: /schedule add <interval> <command>  ·  /schedule remove <id>  ·  /schedule run <id>${colors.reset}`,
    );
    return lines.join('\n');
  }
}

/**
 * Manages the lightweight local daemon state file (`.taskforge/daemon.json`) and
 * executes due scheduled automations.
 */
export class LocalDaemonController {
  private readonly statePath: string;
  public readonly schedules: ScheduleStore;
  private timer?: NodeJS.Timeout;

  constructor(private readonly repoRoot: string) {
    this.statePath = path.join(repoRoot, DAEMON_FILE);
    this.schedules = new ScheduleStore(repoRoot);
  }

  public getStatus(): { running: boolean; state?: DaemonState } {
    if (!fs.existsSync(this.statePath)) return { running: false };
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as DaemonState;
      let alive = false;
      try {
        process.kill(state.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (!alive) {
        fs.rmSync(this.statePath, { force: true });
        return { running: false };
      }
      return { running: true, state };
    } catch {
      return { running: false };
    }
  }

  public markStarted(uiUrl?: string): DaemonState {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const state: DaemonState = {
      pid: process.pid,
      repoRoot: this.repoRoot,
      startedAt: new Date().toISOString(),
      ...(uiUrl ? { uiUrl } : {}),
    };
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    return state;
  }

  public stopDaemon(): boolean {
    const { running, state } = this.getStatus();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (running && state && state.pid !== process.pid) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(this.statePath)) {
      fs.rmSync(this.statePath, { force: true });
      return true;
    }
    return running;
  }

  public async runDueSchedules(
    executor: (command: string) => Promise<string>,
    nowMs = Date.now(),
  ): Promise<Array<{ id: string; status: 'ok' | 'error'; output: string }>> {
    const due = this.schedules.getDueJobs(nowMs);
    const results: Array<{ id: string; status: 'ok' | 'error'; output: string }> = [];
    for (const job of due) {
      try {
        const output = await executor(job.command);
        this.schedules.markExecuted(job.id, 'ok', output, nowMs);
        results.push({ id: job.id, status: 'ok', output });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.schedules.markExecuted(job.id, 'error', msg, nowMs);
        results.push({ id: job.id, status: 'error', output: msg });
      }
    }
    return results;
  }

  public startPolling(executor: (command: string) => Promise<string>, pollMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runDueSchedules(executor);
    }, pollMs);
    this.timer.unref();
  }
}
