import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeEnvironment, EnvironmentPolicy } from './env-sanitizer.js';
import { AgentExecutionError } from '@taskforge/shared';

export interface ProcessRunOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envPolicy?: EnvironmentPolicy;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  logPath?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void;
  stdin?: import('node:stream').Readable | string;
}

export interface ProcessRunResult {
  pid?: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export class ProcessRunner {
  public static async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const {
      command,
      args = [],
      cwd = process.cwd(),
      env = {},
      envPolicy,
      timeoutMs = 60000,
      abortSignal,
      logPath,
      onStdout,
      onStderr,
      onSpawn,
      stdin,
    } = options;

    const sanitizedEnv = sanitizeEnvironment(process.env, env, envPolicy);

    let logStream: fs.WriteStream | undefined;
    if (logPath) {
      const logDir = path.dirname(path.resolve(logPath));
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      logStream = fs.createWriteStream(logPath, { flags: 'a' });
    }

    return new Promise<ProcessRunResult>((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let timer: NodeJS.Timeout | undefined;
      let child: ChildProcess | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (logStream) logStream.end();
        if (child?.stdin && !child.stdin.destroyed) {
          try {
            child.stdin.end();
          } catch {}
        }
      };

      const useStdinPipe = Boolean(stdin || onSpawn);

      try {
        child = spawn(command, args, {
          cwd,
          env: sanitizedEnv,
          stdio: [useStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        cleanup();
        return reject(
          new AgentExecutionError(`Failed to spawn process ${command}: ${(err as Error).message}`, {
            command,
            args,
            error: err,
          }),
        );
      }

      if (onSpawn && child) {
        try {
          onSpawn(child);
        } catch {
          // ignore callback error
        }
      }

      if (stdin && child?.stdin) {
        try {
          if (typeof stdin === 'string') {
            child.stdin.write(stdin);
            child.stdin.end();
          } else {
            stdin.pipe(child.stdin);
          }
        } catch {
          // ignore stdin error
        }
      }

      const pid = child.pid;

      const killProcess = (signal: NodeJS.Signals = 'SIGTERM') => {
        if (!child || child.killed) return;
        try {
          if (pid && process.platform !== 'win32') {
            // Kill entire process group
            try {
              process.kill(-pid, signal);
            } catch {
              child.kill(signal);
            }
          } else {
            child.kill(signal);
          }
        } catch {
          // ignore already dead
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcess('SIGTERM');
          setTimeout(() => {
            killProcess('SIGKILL');
          }, 2000);
        }, timeoutMs);
      }

      if (abortSignal) {
        if (abortSignal.aborted) {
          cancelled = true;
          killProcess('SIGKILL');
        } else {
          abortSignal.addEventListener('abort', () => {
            cancelled = true;
            killProcess('SIGTERM');
            setTimeout(() => {
              killProcess('SIGKILL');
            }, 2000);
          });
        }
      }

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        if (logStream) logStream.write(data);
        if (onStdout) onStdout(text);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        if (logStream) logStream.write(data);
        if (onStderr) onStderr(text);
      });

      child.on('error', (err) => {
        cleanup();
        reject(
          new AgentExecutionError(`Process error for ${command}: ${err.message}`, {
            command,
            pid,
            error: err,
          }),
        );
      });

      child.on('close', (code, signal) => {
        cleanup();
        const durationMs = Date.now() - startTime;
        const exitCode = code ?? (signal ? 128 : 1);

        resolve({
          pid,
          exitCode,
          stdout,
          stderr,
          durationMs,
          timedOut,
          cancelled,
        });
      });
    });
  }
}
