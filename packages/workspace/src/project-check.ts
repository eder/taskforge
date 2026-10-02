import { ProcessRunner, DEFAULT_ENV_POLICY, EnvironmentPolicy } from '@taskforge/execution';

export type CheckStatus = 'passed' | 'failed' | 'timeout' | 'cancelled';

export interface CheckResult {
  status: CheckStatus;
  exitCode: number;
  durationMs: number;
  /** Last lines of combined output, for display. */
  tail: string[];
  /** A specific, actionable hint when the failure matches a known pattern. */
  tip?: string;
}

export interface CheckOptions {
  cwd: string;
  /** Hard limit; the command is killed after this. */
  timeoutSeconds: number;
  signal?: AbortSignal;
  /** Called with each chunk of output as it arrives. */
  onOutput?: (chunk: string) => void;
  /** Called every `heartbeatSeconds` while the command is running. */
  onHeartbeat?: (elapsedSeconds: number) => void;
  heartbeatSeconds?: number;
  /** Environment policy for the command (defaults to inheriting minus secret-looking names). */
  envPolicy?: EnvironmentPolicy;
}

/** Recognized failures whose cause is common and whose fix is not obvious. */
export function tipForFailure(command: string, output: string): string | undefined {
  if (/async def functions are not natively supported/i.test(output)) {
    return (
      'These tests are asyncio scripts, not pytest tests (pytest has no asyncio plugin here). ' +
      'Run each file as a script instead, e.g. a loop over `python test_<name>.py`.'
    );
  }
  if (/No module named pytest|ModuleNotFoundError/i.test(output)) {
    return 'A Python dependency is missing for the interpreter this command uses. Check the virtualenv path.';
  }
  if (/command not found|No such file or directory/i.test(output) && /\.venv|venv/.test(command)) {
    return 'The virtualenv in this command was not found. Check its path (it is created per project).';
  }
  if (/connection refused|could not connect|ECONNREFUSED/i.test(output)) {
    return 'The tests need a running service (database, server). Leave those out of verification.commands.';
  }
  return undefined;
}

/**
 * Runs one command through the shell exactly the way verification does, but
 * for `tf init --check`: bounded, cancellable, with live output and a
 * heartbeat so a slow or stuck command is visible instead of silent. stdin is
 * closed, so a command that waits for input fails fast instead of hanging.
 */
export async function runCheckCommand(command: string, options: CheckOptions): Promise<CheckResult> {
  const started = Date.now();
  const heartbeatMs = Math.max(1, options.heartbeatSeconds ?? 10) * 1000;
  const heartbeat = options.onHeartbeat
    ? setInterval(() => options.onHeartbeat?.(Math.round((Date.now() - started) / 1000)), heartbeatMs)
    : undefined;

  try {
    const res = await ProcessRunner.run({
      command: 'sh',
      args: ['-c', command],
      cwd: options.cwd,
      timeoutMs: options.timeoutSeconds * 1000,
      abortSignal: options.signal,
      onStdout: options.onOutput,
      onStderr: options.onOutput,
      envPolicy: options.envPolicy ?? {
        inherit: true,
        denyPatterns: [...(DEFAULT_ENV_POLICY.denyPatterns ?? []), 'TASKFORGE_OPENAI_API_KEY'],
      },
    });
    const combined = `${res.stdout}\n${res.stderr}`;
    const tail = combined
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-6);
    const status: CheckStatus = res.cancelled
      ? 'cancelled'
      : res.timedOut
        ? 'timeout'
        : res.exitCode === 0
          ? 'passed'
          : 'failed';
    return {
      status,
      exitCode: res.exitCode,
      durationMs: Date.now() - started,
      tail,
      tip: status === 'failed' || status === 'timeout' ? tipForFailure(command, combined) : undefined,
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
