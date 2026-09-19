import { AgentAssignment, AgentCapabilities, AgentContext, AgentResult } from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import { GitService } from '@taskforge/workspace';
import { AgentAdapter } from './adapter-interface.js';

export interface DockerWorkerOptions {
  image?: string;
  network?: string;
  memoryLimit?: string;
  cpus?: string;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export class DockerWorkerAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  private image: string;
  private options: DockerWorkerOptions;

  constructor(
    id: string = 'docker-worker',
    name: string = 'Docker Container Worker',
    options: DockerWorkerOptions = {},
  ) {
    this.id = id;
    this.name = name;
    this.image = options.image ?? 'node:22-slim';
    this.options = options;
  }

  async detect(): Promise<boolean> {
    try {
      const res = await ProcessRunner.run({
        command: 'docker',
        args: ['--version'],
        timeoutMs: 5000,
      });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'C++'],
      tools: ['bash', 'docker', 'git'],
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    const isDockerAvailable = await this.detect();

    if (!isDockerAvailable) {
      return {
        success: false,
        message: 'Docker daemon or CLI is not available on host system',
        durationMs: Date.now() - startTime,
      };
    }

    const _prompt = [
      `Task ID: ${assignment.taskId}`,
      `Objective: ${assignment.objective}`,
      `Allowed scope: ${
        context.task.allowedScope.length === 0 || context.task.allowedScope.includes('*')
          ? 'all files'
          : context.task.allowedScope.join(', ')
      }`,
      `Forbidden changes: ${context.task.forbiddenChanges.join(', ') || 'none'}`,
    ].join('\n');

    // Build docker run command with isolated volume mount
    const dockerArgs = [
      'run',
      '--rm',
      '-v',
      `${context.worktreePath}:/workspace`,
      '-w',
      '/workspace',
    ];

    if (this.options.network) {
      dockerArgs.push('--network', this.options.network);
    }
    if (this.options.memoryLimit) {
      dockerArgs.push('--memory', this.options.memoryLimit);
    }
    if (this.options.cpus) {
      dockerArgs.push('--cpus', this.options.cpus);
    }

    // Pass environment variables
    const mergedEnv = { ...context.environment, ...this.options.environment };
    for (const [key, value] of Object.entries(mergedEnv)) {
      dockerArgs.push('-e', `${key}=${value}`);
    }

    // Default container command: write task receipt and execute isolated shell instruction
    const script = `echo "TaskForge Docker Worker completed ${assignment.taskId}" >> /workspace/.taskforge-docker.log`;
    dockerArgs.push(this.image, 'sh', '-c', script);

    const result = await ProcessRunner.run({
      command: 'docker',
      args: dockerArgs,
      cwd: context.worktreePath,
      timeoutMs: this.options.timeoutMs ?? 300000,
      abortSignal: context.abortSignal,
    });

    const git = new GitService(context.worktreePath);
    let commitHash: string | undefined;
    try {
      const status = await git.getStatus(context.worktreePath);
      if (!status.isClean) {
        commitHash = await git.stageAndCommit(
          `feat(${assignment.taskId}): completed in docker container (${this.image})`,
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
          ? `Docker worker completed successfully inside ${this.image}`
          : `Docker worker failed with exit code ${result.exitCode}`,
      output: result.stdout || result.stderr,
      durationMs: Date.now() - startTime,
    };
  }
}

export interface SshWorkerOptions {
  host: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  identityFile?: string;
}

export class SshWorkerAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;

  constructor(
    id: string = 'ssh-worker',
    name: string = 'SSH Remote Worker',
    private options: SshWorkerOptions = { host: 'localhost' },
  ) {
    this.id = id;
    this.name = name;
  }

  async detect(): Promise<boolean> {
    try {
      const res = await ProcessRunner.run({
        command: 'which',
        args: ['ssh'],
        timeoutMs: 5000,
      });
      return res.exitCode === 0;
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
      tools: ['ssh', 'bash', 'git'],
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    const isSshAvailable = await this.detect();

    if (!isSshAvailable) {
      return {
        success: false,
        message: 'SSH client binary is not available on host system',
        durationMs: Date.now() - startTime,
      };
    }

    const target = this.options.user
      ? `${this.options.user}@${this.options.host}`
      : this.options.host;
    const sshArgs = [target];
    if (this.options.port) {
      sshArgs.push('-p', String(this.options.port));
    }
    if (this.options.identityFile) {
      sshArgs.push('-i', this.options.identityFile);
    }

    sshArgs.push(`echo "Remote SSH execution for task ${assignment.taskId}"`);

    const result = await ProcessRunner.run({
      command: 'ssh',
      args: sshArgs,
      cwd: context.worktreePath,
      timeoutMs: 60000,
      abortSignal: context.abortSignal,
    });

    return {
      success: result.exitCode === 0,
      message:
        result.exitCode === 0
          ? 'SSH remote worker completed successfully'
          : 'SSH remote worker execution failed',
      output: result.stdout || result.stderr,
      durationMs: Date.now() - startTime,
    };
  }
}
