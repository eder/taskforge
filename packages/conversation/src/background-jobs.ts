import { colors } from './theme.js';

export interface BackgroundJob {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  output?: string;
  error?: string;
}

/**
 * Manages asynchronous REPL background jobs (`& <command>` and `/bg [id]`) so
 * heavy tasks like `/council` or `@codex -> @agy` can run without blocking `tf>`.
 */
export class BackgroundJobManager {
  private jobs: BackgroundJob[] = [];
  private seq = 0;

  constructor(private readonly onJobFinished?: (job: BackgroundJob) => void) {}

  public start(command: string, task: () => Promise<string>): BackgroundJob {
    this.seq += 1;
    const id = `bg-${this.seq}`;
    const startMs = Date.now();
    const job: BackgroundJob = {
      id,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.jobs.push(job);
    if (this.jobs.length > 30) {
      this.jobs = this.jobs.slice(-30);
    }

    void task()
      .then((output) => {
        job.status = 'completed';
        job.output = output;
        job.finishedAt = new Date().toISOString();
        job.durationMs = Date.now() - startMs;
        this.onJobFinished?.(job);
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = new Date().toISOString();
        job.durationMs = Date.now() - startMs;
        this.onJobFinished?.(job);
      });

    return job;
  }

  public list(): readonly BackgroundJob[] {
    return this.jobs;
  }

  public getRunningCount(): number {
    return this.jobs.filter((j) => j.status === 'running').length;
  }

  public get(idOrNum: string): BackgroundJob | undefined {
    const norm = idOrNum.trim().toLowerCase();
    return this.jobs.find((j) => j.id === norm || j.id === `bg-${norm}`);
  }

  public formatList(): string {
    if (this.jobs.length === 0) {
      return `${colors.dim}No background jobs yet. Prefix any command with "& " to run it in the background (e.g. "& /council ...").${colors.reset}`;
    }
    const lines = [
      `${colors.brand}✦ ${colors.bold}Background Jobs${colors.reset} ${colors.dim}(${this.getRunningCount()} running · ${this.jobs.length} total)${colors.reset}`,
    ];
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i];
      const icon =
        j.status === 'running'
          ? `${colors.cyan}●${colors.reset}`
          : j.status === 'completed'
            ? `${colors.green}✔${colors.reset}`
            : `${colors.red}✖${colors.reset}`;
      const dur = j.durationMs !== undefined ? ` (${(j.durationMs / 1000).toFixed(1)}s)` : '';
      lines.push(
        `  ${icon} ${colors.bold}${j.id}${colors.reset} ${colors.dim}${j.status}${dur}${colors.reset} — ${j.command.slice(0, 80)}`,
      );
    }
    lines.push(`  ${colors.dim}Inspect output: /bg <id>${colors.reset}`);
    return lines.join('\n');
  }

  public formatJobOutput(idOrNum: string): string {
    const job = this.get(idOrNum);
    if (!job) {
      return `${colors.red}✖ Background job "${idOrNum}" not found.${colors.reset} Run /bg to list jobs.`;
    }
    if (job.status === 'running') {
      return `${colors.cyan}●${colors.reset} ${colors.bold}${job.id}${colors.reset} is still running: ${job.command}`;
    }
    const header = `${colors.brand}✦ ${colors.bold}${job.id}${colors.reset} ${colors.dim}(${job.status}${job.durationMs !== undefined ? ` · ${(job.durationMs / 1000).toFixed(1)}s` : ''})${colors.reset}`;
    return `${header}\n${job.status === 'completed' ? (job.output ?? '(no output)') : `${colors.red}${job.error ?? 'Failed'}${colors.reset}`}`;
  }
}
