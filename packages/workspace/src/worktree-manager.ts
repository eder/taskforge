import * as path from 'node:path';
import * as fs from 'node:fs';
import { ProcessRunner } from '@taskforge/execution';
import { WorkspaceCreationError } from '@taskforge/shared';
import { GitService } from './git-service.js';

export interface WorktreeInfo {
  taskId: string;
  assignmentId: string;
  path: string;
  branchName: string;
  baseCommit: string;
}

export interface CreateWorktreeOptions {
  detached?: boolean;
}

export class WorktreeManager {
  private activeWorktrees: Map<string, WorktreeInfo> = new Map();

  constructor(
    private repoRoot: string,
    private worktreesBaseDir: string = '.taskforge/worktrees',
  ) {}

  private getWorktreePath(taskId: string, assignmentId: string): string {
    return path.resolve(this.repoRoot, this.worktreesBaseDir, taskId, assignmentId);
  }

  async createWorktree(
    taskId: string,
    assignmentId: string,
    baseCommit: string,
    options?: CreateWorktreeOptions,
  ): Promise<WorktreeInfo> {
    const key = `${taskId}:${assignmentId}`;
    if (this.activeWorktrees.has(key)) {
      return this.activeWorktrees.get(key)!;
    }

    const targetPath = this.getWorktreePath(taskId, assignmentId);
    const isDetached = Boolean(options?.detached);
    const branchName = isDetached ? '' : `taskforge/${taskId}/${assignmentId}`;

    // Safety rule: never allow two parallel assignments to share the exact same path
    for (const [existingKey, existing] of this.activeWorktrees.entries()) {
      if (existing.path === targetPath && existingKey !== key) {
        throw new WorkspaceCreationError(
          `Parallel writable assignment collision! Path ${targetPath} is already in use by assignment ${existingKey}`,
          { taskId, assignmentId, existingKey, path: targetPath },
        );
      }
    }

    // Ensure parent dir exists
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // If dir exists from previous run, remove worktree if git knows it
    if (fs.existsSync(targetPath)) {
      await this.removeWorktree(taskId, assignmentId, true, true).catch(() => {});
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    }

    let targetBaseCommit = baseCommit;
    if (targetBaseCommit === 'EMPTY_TREE' || !targetBaseCommit) {
      const git = new GitService(this.repoRoot);
      targetBaseCommit = await git.ensureInitialCommit();
    }

    const gitArgs = isDetached
      ? ['worktree', 'add', '--detach', targetPath, targetBaseCommit]
      : ['worktree', 'add', '-B', branchName, targetPath, targetBaseCommit];

    const addResult = await ProcessRunner.run({
      command: 'git',
      args: gitArgs,
      cwd: this.repoRoot,
      timeoutMs: 30000,
    });

    if (addResult.exitCode !== 0) {
      throw new WorkspaceCreationError(
        `Failed to create Git worktree at ${targetPath}: ${addResult.stderr}`,
        {
          taskId,
          assignmentId,
          baseCommit,
          targetPath,
          stderr: addResult.stderr,
        },
      );
    }

    const info: WorktreeInfo = {
      taskId,
      assignmentId,
      path: targetPath,
      branchName: isDetached ? 'HEAD (detached)' : branchName,
      baseCommit,
    };

    this.activeWorktrees.set(key, info);
    return info;
  }

  async removeWorktree(
    taskId: string,
    assignmentId: string,
    force: boolean = false,
    deleteBranch: boolean = true,
  ): Promise<void> {
    const key = `${taskId}:${assignmentId}`;
    const info = this.activeWorktrees.get(key);
    const targetPath = this.getWorktreePath(taskId, assignmentId);
    const branchName = info?.branchName ?? `taskforge/${taskId}/${assignmentId}`;

    const removeResult = await ProcessRunner.run({
      command: 'git',
      args: ['worktree', 'remove', force ? '--force' : '', targetPath].filter(Boolean),
      cwd: this.repoRoot,
      timeoutMs: 30000,
    });

    if (fs.existsSync(targetPath)) {
      if (force || removeResult.exitCode !== 0) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        await ProcessRunner.run({
          command: 'git',
          args: ['worktree', 'prune'],
          cwd: this.repoRoot,
        }).catch(() => {});
      }
    }

    if (deleteBranch && branchName && branchName.startsWith('taskforge/')) {
      await ProcessRunner.run({
        command: 'git',
        args: ['branch', '-D', branchName],
        cwd: this.repoRoot,
      }).catch(() => {});
    }

    this.activeWorktrees.delete(key);
  }

  getWorktree(taskId: string, assignmentId: string): WorktreeInfo | undefined {
    return this.activeWorktrees.get(`${taskId}:${assignmentId}`);
  }

  async prune(): Promise<void> {
    await ProcessRunner.run({
      command: 'git',
      args: ['worktree', 'prune'],
      cwd: this.repoRoot,
    });
  }

  async cleanOrphanedWorktreesAndBranches(): Promise<number> {
    // 1. Remove all linked worktrees located inside .taskforge
    const wtListRes = await ProcessRunner.run({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: this.repoRoot,
    });
    if (wtListRes.exitCode === 0) {
      const lines = wtListRes.stdout.split('\n');
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          const wtPath = line.replace('worktree ', '').trim();
          if (wtPath !== this.repoRoot && wtPath.includes('.taskforge')) {
            await ProcessRunner.run({
              command: 'git',
              args: ['worktree', 'remove', '--force', wtPath],
              cwd: this.repoRoot,
            }).catch(() => {});
            if (fs.existsSync(wtPath)) {
              try {
                fs.rmSync(wtPath, { recursive: true, force: true });
              } catch {
                // ignore
              }
            }
          }
        }
      }
    }
    await this.prune().catch(() => {});

    // 2. Delete dangling temporary assignment & integration worker branches
    let deleted = 0;
    const branchRes = await ProcessRunner.run({
      command: 'git',
      args: ['branch', '--list', 'taskforge/*'],
      cwd: this.repoRoot,
    });
    if (branchRes.exitCode === 0) {
      const branches = branchRes.stdout
        .split('\n')
        .map((b) => b.replace(/^[*+\s]+/, '').trim())
        .filter((b) => b.startsWith('taskforge/TASK-') || b.startsWith('taskforge/integration-'));
      for (const b of branches) {
        await ProcessRunner.run({
          command: 'git',
          args: ['branch', '-D', b],
          cwd: this.repoRoot,
        }).catch(() => {});
        deleted++;
      }
    }
    return deleted;
  }
}
