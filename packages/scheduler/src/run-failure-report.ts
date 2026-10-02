import { TaskRepository, EventRepository } from '@taskforge/persistence';

export interface RunFailureLine {
  taskId: string;
  title: string;
  /** 'failed' / 'blocked' ended on their own; 'not_started' never ran. */
  kind: 'failed' | 'blocked' | 'not_started';
  reason?: string;
  /** Branch holding the agents' work for this task, if it was kept. */
  keptBranch?: string;
  /** For not_started tasks: the failed/blocked tasks they were waiting for. */
  waitingOn?: string[];
}

interface ReasonEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: Date;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : undefined;
}

function firstLine(value: unknown): string | undefined {
  const t = typeof value === 'string' ? value.split('\n').map((l) => l.trim()).find(Boolean) : undefined;
  return t ? t.replace(/\s+/g, ' ') : undefined;
}

/** First line of output after a "Last output:" marker, if the text has one. */
function outputLine(value: string): string | undefined {
  const lines = value.split('\n').map((l) => l.trim());
  const marker = lines.findIndex((l) => l.toLowerCase().startsWith('last output'));
  const line = marker >= 0 ? lines.slice(marker + 1).find((l) => l.length > 0) : undefined;
  return line ? line.replace(/\s+/g, ' ').slice(0, 160) : undefined;
}

/** Best human-readable reason a single event can give for a task ending badly. */
function reasonFromEvent(event: ReasonEvent): string | undefined {
  const p = event.payload;
  switch (event.type) {
    case 'TASK_FAILED':
      return text(p.reason);
    case 'TASK_RECOVERY_BLOCKED':
    case 'TASK_RECOVERY_SCHEDULED': {
      const reasonText = typeof p.reason === 'string' ? p.reason : '';
      const headline = firstLine(reasonText);
      // A failed check carries "Command: ..." and "Last output:" lines; show the
      // headline plus the first line of output, not the whole block.
      const output = outputLine(reasonText) ?? outputLine(typeof p.evidence === 'string' ? p.evidence : '');
      const detail = output && output !== headline ? ` — ${output}` : '';
      const prefix =
        p.failureClass === 'verification_configuration'
          ? 'The verification command does not work for this project: '
          : '';
      return headline ? `${prefix}${headline}${detail}` : firstLine(p.evidence);
    }
    case 'COMPLETION_GATE_REJECTED': {
      const evidence = p.evidence as { explanation?: string } | undefined;
      return text(evidence?.explanation) ?? text(p.failureReason);
    }
    case 'ROUTING_INVALID_FOR_TASK':
      return text(p.reason);
    case 'INVESTIGATOR_FAILED':
      return text(p.reason) ? `Investigator failed: ${text(p.reason)}` : undefined;
    case 'SCOPE_VIOLATION': {
      const files = Array.isArray(p.violations) ? (p.violations as string[]).slice(0, 5).join(', ') : '';
      return files ? `Changed files outside the allowed scope: ${files}` : undefined;
    }
    case 'DUAL_REVIEW_REJECTED':
      return 'An independent reviewer rejected the change';
    case 'DUAL_REVIEW_UNAVAILABLE':
      return text(p.reason) ? `Dual review unavailable: ${text(p.reason)}` : undefined;
    case 'MUTATION_BLOCKED':
      return 'A read-only task tried to change the repository';
    default:
      return undefined;
  }
}

/**
 * Explains why a run did not complete: for each task that failed or was
 * blocked, the most recent recorded reason; for each task that never started,
 * which failed task it was waiting for. Reads only persisted state, so it works
 * after the fact (`tf inspect`, the end-of-run summary) and for older runs.
 */
export function describeRunFailures(
  deps: { taskRepo: TaskRepository; eventRepo: EventRepository },
  runId: string,
): RunFailureLine[] {
  const tasks = deps.taskRepo.listByRun(runId);
  const events = deps.eventRepo.listByRun(runId) as unknown as Array<{
    type: string;
    taskId?: string;
    payload: Record<string, unknown>;
    timestamp: Date | string;
  }>;

  const bad = new Set(tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').map((t) => t.id));
  const lines: RunFailureLine[] = [];

  for (const task of tasks) {
    if (bad.has(task.id)) {
      const mine = events
        .filter((e) => e.taskId === task.id)
        .map((e) => ({ type: e.type, payload: e.payload ?? {}, timestamp: new Date(e.timestamp) }))
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      const reason = mine.map(reasonFromEvent).find((r) => r);
      const kept = mine.find((e) => e.type === 'TASK_CANDIDATE_PRESERVED');
      lines.push({
        taskId: task.id,
        title: task.title,
        kind: task.status === 'blocked' ? 'blocked' : 'failed',
        reason,
        keptBranch: typeof kept?.payload.branch === 'string' ? kept.payload.branch : undefined,
      });
    }
  }

  for (const task of tasks) {
    if (bad.has(task.id) || task.status === 'integrated') continue;
    const waitingOn = (task.dependencies ?? []).filter((dep) => bad.has(dep));
    if (waitingOn.length > 0) {
      lines.push({ taskId: task.id, title: task.title, kind: 'not_started', waitingOn });
    }
  }
  return lines;
}

/** Plain-text rendering shared by the CLI and the REPL (callers add color). */
export function formatRunFailureLines(lines: RunFailureLine[], runId: string): string[] {
  if (lines.length === 0) return [];
  const out: string[] = ['Why the run did not complete:'];
  for (const line of lines) {
    if (line.kind === 'not_started') {
      out.push(`  ○ ${line.taskId}  ${line.title}`);
      out.push(`      not started: waiting for ${line.waitingOn?.join(', ')}`);
    } else {
      out.push(`  ✖ ${line.taskId}  ${line.title} [${line.kind.toUpperCase()}]`);
      out.push(
        `      ${line.reason ?? `no reason was recorded; run "tf inspect ${runId}" for the full history`}`,
      );
      if (line.keptBranch) {
        out.push(`      the agents' work is kept on branch ${line.keptBranch} (nothing was lost)`);
      }
    }
  }
  out.push(
    lines.some((l) => l.keptBranch)
      ? `Next: fix the cause, then "tf resume ${runId}" re-checks the kept work without calling agents (add --fresh to start over)   ·   tf inspect ${runId}`
      : `Next: tf resume ${runId}   ·   tf inspect ${runId}`,
  );
  return out;
}
