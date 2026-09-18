import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentResult,
} from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import { GitService } from '@taskforge/workspace';
import { AgentAdapter } from './adapter-interface.js';

export abstract class BaseCliAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly binaryName: string;

  async detect(): Promise<boolean> {
    try {
      const result = await ProcessRunner.run({
        command: 'which',
        args: [this.binaryName],
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
      `Allowed scope: ${context.task.allowedScope.join(', ') || 'all files'}`,
      `Forbidden changes: ${context.task.forbiddenChanges.join(', ') || 'none'}`,
      `Acceptance criteria:`,
      ...context.task.acceptanceCriteria.map((c) => `- ${c}`),
    ].join('\n');
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    const isAvailable = await this.detect();
    if (!isAvailable) {
      return {
        success: false,
        message: `${this.name} CLI ('${this.binaryName}') is not installed or not in PATH`,
        durationMs: Date.now() - startTime,
      };
    }

    const prompt = this.buildPrompt(assignment, context);
    const result = await ProcessRunner.run({
      command: this.binaryName,
      args: ['-p', prompt],
      cwd: context.worktreePath,
      env: context.environment,
      abortSignal: context.abortSignal,
      timeoutMs: 300000, // 5 minutes default
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

    return {
      success: result.exitCode === 0,
      commitHash,
      message:
        result.exitCode === 0
          ? `${this.name} completed successfully`
          : `${this.name} exited with code ${result.exitCode}`,
      output: result.stdout || result.stderr,
      durationMs: Date.now() - startTime,
    };
  }
}

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly binaryName = 'claude';
}

export class CodexAdapter extends BaseCliAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly binaryName = 'codex';
}

export class GeminiCliAdapter extends BaseCliAdapter {
  readonly id = 'gemini';
  readonly name = 'Gemini CLI';
  readonly binaryName = 'gemini';
}
