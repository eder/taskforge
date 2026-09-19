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
  ): Promise<WorktreeInfo> {
    const key = `${taskId}:${assignmentId}`;
    if (this.activeWorktrees.has(key)) {
      return this.activeWorktrees.get(key)!;
    }

    const targetPath = this.getWorktreePath(taskId, assignmentId);
    const branchName = `taskforge/${taskId}/${assignmentId}`;

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
      await this.removeWorktree(taskId, assignmentId, true).catch(() => {});
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    }

    let targetBaseCommit = baseCommit;
    if (targetBaseCommit === 'EMPTY_TREE' || !targetBaseCommit) {
      const git = new GitService(this.repoRoot);
      targetBaseCommit = await git.ensureInitialCommit();
    }

    const addResult = await ProcessRunner.run({
      command: 'git',
      args: ['worktree', 'add', '-B', branchName, targetPath, targetBaseCommit],
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
      branchName,
      baseCommit,
    };

    this.activeWorktrees.set(key, info);
    return info;
  }

  async removeWorktree(
    taskId: string,
    assignmentId: string,
    force: boolean = false,
  ): Promise<void> {
    const key = `${taskId}:${assignmentId}`;
    const targetPath = this.getWorktreePath(taskId, assignmentId);

    const removeResult = await ProcessRunner.run({
      command: 'git',
      args: ['worktree', 'remove', force ? '--force' : '', targetPath].filter(Boolean),
      cwd: this.repoRoot,
      timeoutMs: 30000,
    });

    if (removeResult.exitCode !== 0 && fs.existsSync(targetPath)) {
      // Worktree might not be in git tracking or dirty; if force, manual delete and prune
      if (force) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        await ProcessRunner.run({
          command: 'git',
          args: ['worktree', 'prune'],
          cwd: this.repoRoot,
        });
      }
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
}
