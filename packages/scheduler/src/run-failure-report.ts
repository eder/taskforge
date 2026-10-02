import { TaskRepository, EventRepository } from '@taskforge/persistence';
import { describeCompletionFailure } from './task-recovery.js';

export interface RunFailureLine {
  taskId: string;
  title: string;
  /** 'failed' / 'blocked' ended on their own; 'not_started' never ran. */
  kind: 'failed' | 'blocked' | 'not_started' | 'budget';
  reason?: string;
  /** Branch holding the agents' work for this task, if it was kept. */
  keptBranch?: string;
  /** For not_started tasks: the failed/blocked tasks they were waiting for. */
  waitingOn?: string[];
  /** What kind of problem stopped the task (see task-recovery.ts), when recorded. */
  failureClass?: string;
  /** For 'budget': what was spent against the cap. */
  budget?: { spent: number; budget: number };
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
      // Runs recorded before reasons were written in words stored the bare code.
      const headline = /^[A-Z][A-Z_]+$/.test(reasonText.trim())
        ? describeCompletionFailure(reasonText.trim())
        : firstLine(reasonText);
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

  // A run that stopped on its token budget has no failed task to point at; say
  // so, unless the run was resumed since (then the budget stop is history).
  const lastStop = [...events]
    .filter((e) => e.type === 'TOKEN_BUDGET_REACHED' || e.type === 'RUN_RESUMED')
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  const budgetLines: RunFailureLine[] =
    lastStop?.type === 'TOKEN_BUDGET_REACHED'
      ? [
          {
            taskId: '',
            title: '',
            kind: 'budget',
            budget: { spent: Number(lastStop.payload.spent), budget: Number(lastStop.payload.budget) },
            reason: `Stopped at the token budget: ${Number(lastStop.payload.spent).toLocaleString('en-US')} of ${Number(lastStop.payload.budget).toLocaleString('en-US')} tokens. The remaining tasks were not started and nothing was lost.`,
          },
        ]
      : [];

  const bad = new Set(tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').map((t) => t.id));
  const lines: RunFailureLine[] = [...budgetLines];

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
        failureClass: mine.map((e) => e.payload.failureClass).find((c) => typeof c === 'string') as string | undefined,
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
    if (line.kind === 'budget') {
      out.push(`  ⏸ ${line.reason}`);
    } else if (line.kind === 'not_started') {
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
  const step = recommendNextStep(lines, runId);
  if (step) {
    out.push(`Next: ${step.command}   — ${step.why}`);
    out.push(`Also: ${step.alternatives.join('   ·   ')}`);
  }
  return out;
}

export interface NextStep {
  /** The one thing to do now. */
  command: string;
  why: string;
  /** Safe to run for the person right away (no fix needed first, no extra spend decision). */
  runnable: boolean;
  alternatives: string[];
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/**
 * Picks the single most useful next action for a run that did not complete, so
 * the person is not handed a menu. Deterministic: it reads the recorded
 * failure classes and the kept work, nothing else.
 */
export function recommendNextStep(lines: RunFailureLine[], runId: string): NextStep | undefined {
  if (lines.length === 0) return undefined;
  const abandon = `tf abandon ${runId} (if no longer needed)`;
  const inspect = `tf inspect ${runId}`;
  const kept = lines.some((l) => l.keptBranch);

  const budget = lines.find((l) => l.kind === 'budget')?.budget;
  if (budget) {
    const suggested = roundUp(Math.max(budget.budget * 2, budget.spent + 100_000), 100_000);
    return {
      command: `tf resume ${runId} --budget ${suggested}`,
      why: 'continue where it stopped with a higher token cap (what was already spent counts)',
      runnable: false,
      alternatives: [`tf cost ${runId}`, abandon],
    };
  }

  if (lines.some((l) => l.failureClass === 'verification_configuration')) {
    return {
      command: 'tf init --check',
      why: `a check command does not work for this project, so no change can be verified; fix it, then "tf resume ${runId}" re-checks the kept work without calling agents`,
      runnable: false,
      alternatives: [`tf resume ${runId}`, inspect],
    };
  }

  if (lines.some((l) => l.failureClass === 'environment')) {
    return {
      command: `tf resume ${runId}`,
      why: 'after fixing the environment problem above; the kept work is re-checked without calling agents',
      runnable: false,
      alternatives: [inspect, abandon],
    };
  }

  if (lines.some((l) => l.failureClass === 'policy')) {
    return {
      command: inspect,
      why: 'a policy stopped the run; see which one and adjust the config or the request',
      runnable: false,
      alternatives: [`tf resume ${runId}`, abandon],
    };
  }

  return {
    command: `tf resume ${runId}`,
    why: kept
      ? 'the agent continues from its kept work with the failure evidence'
      : 'keeps what was integrated and runs the rest again',
    runnable: true,
    alternatives: [...(kept ? [`tf resume ${runId} --fresh (start the tasks over)`] : []), abandon, inspect],
  };
}
