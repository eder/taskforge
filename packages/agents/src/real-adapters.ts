import { AgentAssignment, AgentCapabilities, AgentContext, AgentResult } from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import { GitService } from '@taskforge/workspace';
import { AgentAdapter } from './adapter-interface.js';
import { AgentQuotaTracker } from './quota-tracker.js';

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
        inherit: true,
        denyPatterns: [],
      },
      abortSignal: context.abortSignal,
      timeoutMs,
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

    const output = result.stdout || result.stderr;
    if (result.exitCode === 0) {
      AgentQuotaTracker.getInstance().recordSuccess(this.id);
    } else {
      AgentQuotaTracker.getInstance().recordFailure(this.id, output);
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
    super({ defaultArgs: ['--dangerously-skip-permissions', '-p'], ...options });
  }
}

export class CodexAdapter extends BaseCliAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly binaryName = 'codex';

  constructor(options: CliAdapterOptions = {}) {
    super({ defaultArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox'], ...options });
  }
}

export class AntigravityAdapter extends BaseCliAdapter {
  readonly id = 'agy';
  readonly name = 'Google Antigravity';
  readonly binaryName = 'agy';

  constructor(options: CliAdapterOptions = {}) {
    super({ defaultArgs: ['--dangerously-skip-permissions', '-p'], ...options });
  }
}
