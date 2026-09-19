import * as path from 'node:path';
import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentMessage,
  AgentResult,
  AgentSession,
} from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import { GitService } from '@taskforge/workspace';
import { AgentAdapter } from './adapter-interface.js';
import { AgentQuotaTracker } from './quota-tracker.js';
import { RealCliAgentSession } from './agent-session.js';

export interface CliAdapterOptions {
  binaryPath?: string;
  defaultArgs?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export abstract class BaseCliAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly binaryName: string;

  protected options: CliAdapterOptions;

  constructor(options: CliAdapterOptions = {}) {
    this.options = options;
  }

  get commandBinary(): string {
    return this.options.binaryPath || this.binaryName;
  }

  async detect(): Promise<boolean> {
    try {
      const result = await ProcessRunner.run({
        command: 'which',
        args: [this.commandBinary],
        timeoutMs: 5000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust'],
      tools: ['bash', 'file_editor', 'git'],
    };
  }

  protected buildPrompt(assignment: AgentAssignment, context: AgentContext): string {
    return [
      `Task ID: ${assignment.taskId}`,
      `Assignment ID: ${assignment.id}`,
      `Role: ${assignment.role}`,
      `Objective: ${assignment.objective}`,
      `Allowed scope: ${
        context.task.allowedScope.length === 0 || context.task.allowedScope.includes('*')
          ? 'all files'
          : context.task.allowedScope.join(', ')
      }`,
      `Forbidden changes: ${context.task.forbiddenChanges.join(', ') || 'none'}`,
      `Acceptance criteria:`,
      ...context.task.acceptanceCriteria.map((c) => `- ${c}`),
    ].join('\n');
  }

  protected formatArgs(prompt: string): string[] {
    if (this.options.defaultArgs && this.options.defaultArgs.length > 0) {
      return [...this.options.defaultArgs, prompt];
    }
    return ['-p', prompt];
  }

  protected extractActivity(chunk: string, callback?: (activity: string) => void): void {
    if (!callback) return;

    const lines = chunk.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const obj = JSON.parse(trimmed);

          // 1. Claude Code assistant content
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const item of obj.message.content) {
              if (item.type === 'tool_use') {
                const name = item.name;
                const input = item.input ?? {};
                if (name === 'Bash' && input.command) {
                  const cmd =
                    input.command.length > 45 ? `${input.command.slice(0, 42)}...` : input.command;
                  callback(`Bash: ${cmd}`);
                  return;
                }
                if (name === 'Edit' && input.file_path) {
                  callback(`Edit ${path.basename(input.file_path)}`);
                  return;
                }
                if (name === 'Read' && input.file_path) {
                  callback(`Read ${path.basename(input.file_path)}`);
                  return;
                }
                if (name === 'Write' && input.file_path) {
                  callback(`Write ${path.basename(input.file_path)}`);
                  return;
                }
                callback(`Tool ${name}`);
                return;
              }
              if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
                const snippet = item.text.trim().split('\n')[0];
                const cleaned = snippet.length > 50 ? `${snippet.slice(0, 47)}...` : snippet;
                callback(cleaned);
                return;
              }
            }
          }

          // 2. Claude Code content block start with tool_use
          if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
            callback(`Starting tool ${obj.content_block.name}...`);
            return;
          }

          // 3. AGY step update
          if (obj.event === 'step_update') {
            const desc =
              obj.step_update?.description || obj.step_update?.tool || 'Executing step...';
            const cleaned = desc.length > 50 ? `${desc.slice(0, 47)}...` : desc;
            callback(cleaned);
            return;
          }

          // 4. Codex item
          if (obj.type === 'item' && obj.item) {
            const desc = obj.item.command || obj.item.type || 'Processing...';
            callback(desc.length > 50 ? `${desc.slice(0, 47)}...` : desc);
            return;
          }
        } catch {
          // ignore json parse error
        }
      }
    }

    const rawLines = chunk
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('{'));

    if (rawLines.length > 0) {
      const lastLine = rawLines[rawLines.length - 1];
      const cleaned = lastLine.length > 64 ? `${lastLine.slice(0, 61)}...` : lastLine;
      callback(cleaned);
    }
  }

  protected extractOutput(rawStdout: string, rawStderr: string): string {
    const raw = rawStdout || rawStderr;
    if (!raw) return '';

    const lines = raw.split('\n');
    let finalResult: string | undefined;
    const assistantTexts: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'result' && typeof obj.result === 'string') {
          finalResult = obj.result;
        } else if (obj.event === 'result' && typeof obj.result === 'string') {
          finalResult = obj.result;
        } else if (obj.type === 'assistant' && obj.message?.content) {
          for (const item of obj.message.content) {
            if (item.type === 'text' && item.text) {
              assistantTexts.push(item.text);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (finalResult && finalResult.trim().length > 0) {
      return finalResult;
    }
    if (assistantTexts.length > 0) {
      return assistantTexts.join('\n\n');
    }

    return raw;
  }

  protected activeSessions: Map<string, RealCliAgentSession> = new Map();

  async createSession(assignment: AgentAssignment, context: AgentContext): Promise<AgentSession> {
    const sessionId = `cli-session-${assignment.id}`;
    const session = new RealCliAgentSession(sessionId, assignment.id, {
      adapterId: this.id,
      adapterName: this.name,
      taskId: assignment.taskId,
      onEvent: (event) => {
        context.onEvent?.(event);
      },
    });
    this.activeSessions.set(assignment.id, session);
    return session;
  }

  async send(sessionId: string, message: AgentMessage): Promise<void> {
    for (const session of this.activeSessions.values()) {
      if (session.sessionId === sessionId) {
        await session.send(message);
        return;
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    for (const session of this.activeSessions.values()) {
      if (session.sessionId === sessionId) {
        await session.cancel();
        return;
      }
    }
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    const isAvailable = await this.detect();
    if (!isAvailable) {
      return {
        success: false,
        message: `${this.name} CLI ('${this.commandBinary}') is not installed or not in PATH`,
        durationMs: Date.now() - startTime,
      };
    }

    let session = this.activeSessions.get(assignment.id);
    if (!session) {
      session = (await this.createSession(assignment, context)) as RealCliAgentSession;
    }

    const prompt = this.buildPrompt(assignment, context);
    const args = this.formatArgs(prompt);
    const timeoutMs = this.options.timeoutMs ?? 300000; // 5 minutes default

    const result = await ProcessRunner.run({
      command: this.commandBinary,
      args,
      cwd: context.worktreePath,
      env: {
        ...context.environment,
        ...this.options.env,
      },
      envPolicy: {
        inherit: false,
        allow: [
          'PATH',
          'HOME',
          'USER',
          'SHELL',
          'TMPDIR',
          'NODE_ENV',
          'LANG',
          'TERM',
          'ANTHROPIC_API_KEY',
          'OPENAI_API_KEY',
          'GEMINI_API_KEY',
          'GOOGLE_API_KEY',
          'SSH_AUTH_SOCK',
          'GIT_AUTHOR_NAME',
          'GIT_AUTHOR_EMAIL',
          'GIT_COMMITTER_NAME',
          'GIT_COMMITTER_EMAIL',
          'PNPM_HOME',
          'NVM_DIR',
          'DENO_INSTALL',
          'BUN_INSTALL',
        ],
        denyPatterns: ['*PASSWORD*', '*SECRET*', '*TOKEN*'],
      },
      abortSignal: context.abortSignal,
      timeoutMs,
      logPath: context.logPath,
      onSpawn: (child) => {
        if (session instanceof RealCliAgentSession) {
          session.attachProcess(child);
        }
      },
      onStdout: (chunk) => {
        if (session instanceof RealCliAgentSession) {
          session.handleOutputChunk(chunk, 'stdout');
        }
        this.extractActivity(chunk, context.onActivity);
      },
      onStderr: (chunk) => {
        if (session instanceof RealCliAgentSession) {
          session.handleOutputChunk(chunk, 'stderr');
        }
        this.extractActivity(chunk, context.onActivity);
      },
    });

    const git = new GitService(context.worktreePath);
    let commitHash: string | undefined;
    try {
      const status = await git.getStatus(context.worktreePath);
      if (!status.isClean) {
        commitHash = await git.stageAndCommit(
          `feat(${assignment.taskId}): completed by ${this.name}`,
          context.worktreePath,
        );
      } else {
        commitHash = status.headCommit;
      }
    } catch {
      // ignore git error if any
    }

    const rawOutput = result.stdout || result.stderr;
    const output = this.extractOutput(result.stdout, result.stderr);
    if (result.exitCode === 0) {
      AgentQuotaTracker.getInstance().recordSuccess(this.id);
    } else {
      AgentQuotaTracker.getInstance().recordFailure(this.id, rawOutput);
    }

    return {
      success: result.exitCode === 0,
      commitHash,
      message:
        result.exitCode === 0
          ? `${this.name} completed successfully`
          : `${this.name} exited with code ${result.exitCode}`,
      output,
      durationMs: Date.now() - startTime,
    };
  }
}

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly binaryName = 'claude';

  constructor(options: CliAdapterOptions = {}) {
    super({
      defaultArgs: [
        '--output-format=stream-json',
        '--verbose',
        '-p',
      ],
      ...options,
    });
  }
}

export class CodexAdapter extends BaseCliAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly binaryName = 'codex';

  constructor(options: CliAdapterOptions = {}) {
    super({
      defaultArgs: [
        'exec',
        '--json',
      ],
      ...options,
    });
  }
}

export class AntigravityAdapter extends BaseCliAdapter {
  readonly id = 'agy';
  readonly name = 'Google Antigravity';
  readonly binaryName = 'agy';

  constructor(options: CliAdapterOptions = {}) {
    super({
      defaultArgs: [
        '--output-format',
        'stream-json',
        '-p',
      ],
      ...options,
    });
  }
}
