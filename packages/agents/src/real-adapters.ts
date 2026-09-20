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
      stdinMode: 'interactive',
      permissionProtocol: 'structured',
      questionProtocol: 'structured',
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

  public normalizeOutcome(
    rawStdout: string,
    rawStderr: string,
    exitCode: number,
    logPath?: string,
  ): import('@taskforge/shared').ProviderExecutionOutcome {
    const combined = [rawStdout, rawStderr].filter(Boolean).join('\n');
    const lines = combined.split('\n');

    let providerStatus: string | undefined;
    let candidateResponse = '';
    const assistantTexts: string[] = [];
    const deniedActions: import('@taskforge/shared').DeniedAction[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const artifacts: Array<{ path: string; description?: string; type?: string }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const obj = JSON.parse(trimmed);

          // 1. Antigravity & structured provider status
          if (typeof obj.status === 'string') {
            providerStatus = obj.status;
          }

          // 2. Denied actions (Antigravity & Claude)
          // Antigravity: denied_actions: ["RunCommand"] or [{ action: "RunCommand" }]
          const rawDenied = obj.denied_actions ?? obj.deniedActions;
          if (Array.isArray(rawDenied)) {
            for (const d of rawDenied) {
              if (typeof d === 'string') {
                deniedActions.push({ action: d });
              } else if (d && typeof d === 'object') {
                deniedActions.push({
                  action: d.action || d.name || 'UnknownAction',
                  reason: d.reason,
                  command: d.command,
                });
              }
            }
          }
          if (
            obj.type === 'action_denied' ||
            obj.event === 'action_denied' ||
            obj.type === 'permission_denied' ||
            obj.action === 'denied'
          ) {
            deniedActions.push({
              action: obj.action || obj.operation || obj.command || 'UnknownAction',
              reason: obj.reason,
              command: obj.command,
            });
          }

          // 3. Responses and results
          if (typeof obj.response === 'string' && obj.response.trim().length > 0) {
            candidateResponse = obj.response;
          } else if (typeof obj.result === 'string' && obj.result.trim().length > 0) {
            candidateResponse = obj.result;
          } else if (
            obj.type === 'result' &&
            obj.result &&
            typeof obj.result.response === 'string'
          ) {
            candidateResponse = obj.result.response;
          }

          // 4. Assistant text content
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const item of obj.message.content) {
              if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
                assistantTexts.push(item.text);
              }
            }
          }

          // 5. Artifact tracking
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const item of obj.message.content) {
              if (item.type === 'tool_use' && (item.name === 'Edit' || item.name === 'Write')) {
                if (item.input?.file_path) {
                  artifacts.push({ path: item.input.file_path, type: 'modified_file' });
                }
              }
            }
          }

          // 6. Errors & warnings
          if (obj.error) {
            errors.push(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error));
          }
          if (obj.warning) {
            warnings.push(
              typeof obj.warning === 'string' ? obj.warning : JSON.stringify(obj.warning),
            );
          }
        } catch {
          // ignore parse errors
        }
      } else {
        const jetskiMatch = trimmed.match(
          /(?:jetski:.*)?(?:a tool )?required the ["']?([A-Za-z0-9_]+)["']? permission.*(?:auto-denied|denied)/i,
        );
        if (jetskiMatch) {
          deniedActions.push({
            action: jetskiMatch[1],
            reason: trimmed,
          });
          errors.push(trimmed);
        } else {
          const denialMatch = trimmed.match(
            /(?:permission(?: was)? denied|action denied|denied action)[:\s]+(?:for action\s+)?([A-Za-z0-9_]+)(?:\(([^)]+)\))?/i,
          );
          if (denialMatch) {
            deniedActions.push({
              action: denialMatch[1],
              command: denialMatch[2],
              reason: trimmed,
            });
          }
        }
      }
    }

    let finalResponse = candidateResponse;
    if (!finalResponse && assistantTexts.length > 0) {
      finalResponse = assistantTexts.join('\n\n');
    }
    if (!finalResponse && rawStdout) {
      const nonJsonLines = rawStdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('{'));
      if (nonJsonLines.length > 0) {
        finalResponse = nonJsonLines.join('\n');
      }
    }

    if (!providerStatus) {
      providerStatus = exitCode === 0 && deniedActions.length === 0 ? 'SUCCESS' : 'FAILED';
    }

    // Capture non-JSON stderr lines if exit was non-zero and no errors recorded
    if (exitCode !== 0 && errors.length === 0 && rawStderr) {
      const nonJsonStderr = rawStderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('{'));
      if (nonJsonStderr.length > 0) {
        errors.push(nonJsonStderr.slice(-3).join('\n'));
      }
    }

    return {
      processExitCode: exitCode,
      providerStatus,
      finalResponse: (finalResponse ?? '').trim(),
      deniedActions,
      unresolvedInteractions: [],
      errors,
      warnings,
      artifacts,
      runtimeLogRef: logPath,
    };
  }

  protected extractOutput(
    rawStdout: string,
    rawStderr: string,
    outcome?: import('@taskforge/shared').ProviderExecutionOutcome,
  ): string {
    const effectiveOutcome = outcome ?? this.normalizeOutcome(rawStdout, rawStderr, 0);
    if (effectiveOutcome && effectiveOutcome.finalResponse) {
      return effectiveOutcome.finalResponse;
    }

    // Extract non-JSON text lines if any, NEVER raw JSON
    const combined = [rawStdout, rawStderr].filter(Boolean).join('\n');
    const nonJsonLines = combined
      .split('\n')
      // eslint-disable-next-line no-control-regex
      .map((l) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim())
      .filter((l) => l.length > 0 && !l.startsWith('{') && !l.startsWith('['));

    if (nonJsonLines.length > 0) {
      return nonJsonLines.join('\n');
    }

    return '';
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

  releaseSession(assignmentId: string): void {
    this.activeSessions.delete(assignmentId);
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

    const caps = await this.capabilities();
    const closeStdinOnSpawn = caps.stdinMode === 'close_after_spawn';

    const result = await ProcessRunner.run({
      command: this.commandBinary,
      args,
      cwd: context.worktreePath,
      closeStdinOnSpawn,
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
          'CLAUDE_CODE_OAUTH_TOKEN',
          'CLAUDE_API_KEY',
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN',
          'OPENAI_API_KEY',
          'TASKFORGE_OPENAI_API_KEY',
          'CODEX_API_KEY',
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
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_CACHE_HOME',
          'CI',
          'COLORTERM',
        ],
        denyPatterns: ['*PASSWORD*', '*SECRET*'],
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

    const outcome = this.normalizeOutcome(
      result.stdout,
      result.stderr,
      result.exitCode,
      context.logPath,
    );
    const output = this.extractOutput(result.stdout, result.stderr, outcome);

    // If required actions were denied, the execution cannot be marked successful
    const hasDeniedRequiredActions = outcome.deniedActions.length > 0;
    const isExecutionSuccessful = result.exitCode === 0 && !hasDeniedRequiredActions;

    if (isExecutionSuccessful) {
      AgentQuotaTracker.getInstance().recordSuccess(this.id);
    } else {
      AgentQuotaTracker.getInstance().recordFailure(this.id, result.stderr || result.stdout);
    }

    let message: string;
    let completionReason: import('@taskforge/shared').CompletionFailureReason | undefined;

    if (hasDeniedRequiredActions) {
      const deniedList = outcome.deniedActions.map((a) => a.action).join(', ');
      const detail = outcome.deniedActions
        .map((a) => a.reason || a.action)
        .filter(Boolean)
        .join('; ');
      message = detail
        ? `${this.name} required action denied: ${detail}`
        : `${this.name} required action denied: ${deniedList}`;
      completionReason = 'REQUIRED_ACTION_DENIED';
    } else if (result.exitCode === 0) {
      message = `${this.name} completed successfully`;
    } else {
      const isAuthError =
        outcome.errors.some((e) =>
          /oauth|authenticate|authentication|api[ _-]?key|unauthorized|forbidden/i.test(e),
        ) ||
        /oauth|authenticate|authentication|api[ _-]?key|unauthorized|forbidden/i.test(
          result.stderr || result.stdout,
        );
      if (isAuthError) {
        const authErr = (
          outcome.errors.find((e) =>
            /oauth|authenticate|authentication|api[ _-]?key|unauthorized|forbidden/i.test(e),
          ) ||
          result.stderr ||
          result.stdout
        )
          .trim()
          .split('\n')[0];
        message = `${this.name} authentication failed: ${authErr}`;
        completionReason = 'HARNESS_FAILED';
      } else {
        message = `${this.name} exited with code ${result.exitCode}`;
        completionReason = 'HARNESS_FAILED';
      }
    }

    return {
      success: isExecutionSuccessful,
      commitHash,
      message,
      output,
      durationMs: Date.now() - startTime,
      normalizedOutcome: outcome,
      completionReason,
    };
  }
}

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly binaryName = 'claude';
  readonly stdinMode = 'interactive';
  readonly permissionProtocol = 'structured';

  constructor(options: CliAdapterOptions = {}) {
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        : ['--output-format=stream-json', '--verbose', '-p'];
    super({
      ...options,
      defaultArgs,
    });
  }

  async capabilities(): Promise<AgentCapabilities> {
    const base = await super.capabilities();
    return {
      ...base,
      stdinMode: 'interactive',
      permissionProtocol: 'structured',
      questionProtocol: 'structured',
    };
  }
}

export class CodexAdapter extends BaseCliAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly binaryName = 'codex';
  readonly stdinMode = 'close_after_spawn';
  readonly permissionProtocol = 'provider_native';

  constructor(options: CliAdapterOptions = {}) {
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        : ['exec', '--json'];
    super({
      ...options,
      defaultArgs,
    });
  }

  async capabilities(): Promise<AgentCapabilities> {
    const base = await super.capabilities();
    return {
      ...base,
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }
}

export class AntigravityAdapter extends BaseCliAdapter {
  readonly id = 'agy';
  readonly name = 'Google Antigravity';
  readonly binaryName = 'agy';
  readonly stdinMode = 'interactive';
  readonly permissionProtocol = 'structured';

  constructor(options: CliAdapterOptions = {}) {
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        : ['--output-format', 'stream-json', '-p'];
    super({
      ...options,
      defaultArgs,
    });
  }

  async capabilities(): Promise<AgentCapabilities> {
    const base = await super.capabilities();
    return {
      ...base,
      stdinMode: 'interactive',
      permissionProtocol: 'structured',
      questionProtocol: 'structured',
    };
  }
}
