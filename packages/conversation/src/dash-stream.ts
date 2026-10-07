import * as fs from 'node:fs';
import { parseAgentStreamEvents } from '@taskforge/agents';
import { AgentStreamBus, ActiveAgentState } from '@taskforge/shared';
import {
  AssignmentRepository,
  ExecutionRecord,
  ExecutionRepository,
  TaskForgeDatabase,
  TaskRepository,
} from '@taskforge/persistence';
import { StreamViewer } from './stream-viewer.js';

/** How recent a log must be for an execution without a pid to count as live. */
const LIVE_LOG_WINDOW_MS = 120_000;

/**
 * Reads what a file has gained since the last call, returning only complete
 * lines: the provider writes JSON lines, and a half-written one must wait for
 * the rest instead of being dropped as invalid.
 */
export class LogTailer {
  private offset = 0;
  private partial = '';

  constructor(private readonly file: string) {}

  readNewLines(): string[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];

    const fd = fs.openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      const text = this.partial + buffer.subarray(0, read).toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Live view of the agents running right now, built only from the project
 * database and the agents' log files. It never talks to the process that is
 * running them, so `tf dash --stream` can be opened in a second terminal while
 * another one runs the work.
 */
export class DashStreamSession {
  private readonly executions: ExecutionRepository;
  private readonly tasks: TaskRepository;
  private readonly assignments: AssignmentRepository;
  private readonly bus = new AgentStreamBus();
  private readonly tailers = new Map<string, LogTailer>();
  private active: ActiveAgentState[] = [];
  private focusIndex = 0;

  constructor(db: TaskForgeDatabase) {
    this.executions = new ExecutionRepository(db);
    this.tasks = new TaskRepository(db);
    this.assignments = new AssignmentRepository(db);
  }

  /** Picks up new executions and new log lines. Call it on a timer. */
  refresh(now: number = Date.now()): void {
    const live = this.executions.listRunning().filter((e) => this.isLive(e, now));
    this.active = live.map((e) => this.toActiveState(e));
    if (this.focusIndex >= this.active.length)
      this.focusIndex = Math.max(0, this.active.length - 1);

    const liveIds = new Set(live.map((e) => e.assignmentId));
    for (const id of [...this.tailers.keys()]) if (!liveIds.has(id)) this.tailers.delete(id);

    for (const execution of live) {
      if (!execution.logPath) continue;
      let tailer = this.tailers.get(execution.assignmentId);
      if (!tailer) {
        tailer = new LogTailer(execution.logPath);
        this.tailers.set(execution.assignmentId, tailer);
      }
      const lines = tailer.readNewLines();
      if (lines.length === 0) continue;
      const state = this.active.find((a) => a.assignmentId === execution.assignmentId)!;
      const events = parseAgentStreamEvents(lines.join('\n'), {
        runId: execution.runId,
        taskId: execution.taskId,
        assignmentId: execution.assignmentId,
        agentId: execution.agentId,
        role: state.role,
      });
      for (const event of events) this.bus.publish(event);
    }
  }

  /** 1-based, as the keys are. Ignored when there is no such agent. */
  focus(position: number): void {
    if (position >= 1 && position <= this.active.length) this.focusIndex = position - 1;
  }

  get agentCount(): number {
    return this.active.length;
  }

  render(maxLines?: number): string {
    const current = this.active[this.focusIndex];
    if (!current) {
      return '  No agent is running right now. Start work with `tf` in another terminal; this view updates by itself.';
    }
    return StreamViewer.renderAssignmentFocusView({
      activeAgent: current,
      allActive: this.active,
      streamEvents: this.bus.history(current.assignmentId),
      maxLines,
    });
  }

  private isLive(execution: ExecutionRecord, now: number): boolean {
    if (execution.pid !== undefined) return isAlive(execution.pid);
    if (!execution.logPath) return false;
    try {
      return now - fs.statSync(execution.logPath).mtimeMs < LIVE_LOG_WINDOW_MS;
    } catch {
      return false;
    }
  }

  private toActiveState(execution: ExecutionRecord): ActiveAgentState {
    const started = new Date(execution.startedAt);
    return {
      taskId: execution.taskId,
      assignmentId: execution.assignmentId,
      taskTitle: this.tasks.get(execution.taskId)?.title ?? execution.taskId,
      agentId: execution.agentId,
      agentName: execution.agentId,
      role: this.assignments.get(execution.assignmentId)?.role ?? 'worker',
      status: execution.status,
      startedAt: started,
      lastActiveAt: new Date(),
      logPath: execution.logPath,
    };
  }
}

/**
 * Full-screen loop for a terminal: redraws about once a second, keys 1-9 pick
 * the agent to watch, q or Ctrl-C leaves. Resolves when the user quits.
 */
export function runDashStream(
  db: TaskForgeDatabase,
  io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } = {
    stdin: process.stdin,
    stdout: process.stdout,
  },
): Promise<void> {
  const session = new DashStreamSession(db);
  const { stdin, stdout } = io;

  if (!stdin.isTTY || !stdout.isTTY) {
    // Piped or redirected: there is no keyboard to wait on, so print one snapshot.
    session.refresh();
    stdout.write(`${session.render()}\n`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const draw = (): void => {
      session.refresh();
      const rows = stdout.rows ?? 30;
      stdout.write(
        `\x1b[2J\x1b[H  TaskForge live view — ${session.agentCount} agent(s) running  •  1-9 switch  •  q quit\n\n${session.render(Math.max(5, rows - 10))}\n`,
      );
    };

    const finish = (): void => {
      clearInterval(timer);
      stdin.off('data', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      resolve();
    };

    const onKey = (chunk: Buffer): void => {
      const key = chunk.toString();
      if (key === 'q' || key === '\u0003') return finish();
      if (/^[1-9]$/.test(key)) {
        session.focus(Number(key));
        draw();
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
    stdout.write('\x1b[?25l');
    const timer = setInterval(draw, 1000);
    draw();
  });
}
