import * as path from 'node:path';
import * as fs from 'node:fs';
import { ProcessRunner } from '@taskforge/execution';
import { WorkspaceCreationError } from '@taskforge/shared';
import { GitService } from './git-service.js';

function isTrackedPathPlaceholder(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true; // dangling symlink or other entry already there
  } catch {
    return false;
  }
}

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

export interface PruneStaleOptions {
  /** Only artifacts untouched for at least this long are removed. */
  olderThanMs: number;
  /** Report what would be removed without removing anything. */
  dryRun?: boolean;
  now?: number;
}

export interface PruneStaleReport {
  worktrees: string[];
  directories: string[];
  branches: string[];
  dryRun: boolean;
}

const AGE_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses ages such as "90m", "12h", "7d", "2w". Throws on anything else. */
export function parseAgeSpec(spec: string): number {
  const match = /^(\d+)([smhdw])$/.exec(spec.trim());
  if (!match) {
    throw new Error(`Invalid age "${spec}". Use a number plus s, m, h, d or w (e.g. 7d).`);
  }
  return Number(match[1]) * AGE_UNITS_MS[match[2]];
}

export class WorktreeManager {
  private activeWorktrees: Map<string, WorktreeInfo> = new Map();

  constructor(
    private repoRoot: string,
    private worktreesBaseDir: string = '.taskforge/worktrees',
    private linkPaths: string[] = [],
  ) {}

  /** Expands link patterns ("*" = one path segment) to existing repo-relative paths. */
  private expandLinkPaths(): string[] {
    const found = new Set<string>();
    for (const pattern of this.linkPaths) {
      const segments = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
      let candidates = [''];
      for (const segment of segments) {
        const next: string[] = [];
        for (const base of candidates) {
          const dir = path.join(this.repoRoot, base);
          if (segment.includes('*')) {
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
            const regex = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
            for (const entry of fs.readdirSync(dir)) {
              if (entry !== '.git' && regex.test(entry)) next.push(path.join(base, entry));
            }
          } else {
            next.push(path.join(base, segment));
          }
        }
        candidates = next;
      }
      for (const rel of candidates) {
        if (rel && fs.existsSync(path.join(this.repoRoot, rel))) found.add(rel);
      }
    }
    return [...found];
  }

  /**
   * Symlinks gitignored dependency directories from the main checkout into a
   * fresh worktree. The links are excluded from git (root-anchored, so the
   * symlink itself is ignored too) and can never be staged by `git add -A`.
   */
  private async linkDependencyDirs(worktreePath: string): Promise<void> {
    const links = this.expandLinkPaths();
    if (links.length === 0) return;
    const git = new GitService(this.repoRoot);
    for (const rel of links) {
      const target = path.join(worktreePath, rel);
      if (fs.existsSync(target) || isTrackedPathPlaceholder(target)) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(path.join(this.repoRoot, rel), target, 'dir');
        await git.ensureLocalExclude(`/${rel.replace(/\\/g, '/')}`);
      } catch {
        // best effort: a missing link only means verification may need its own setup
      }
    }
  }

  /** True only for linked worktrees under the configured TaskForge worktrees dir. */
  private isManagedPath(wtPath: string): boolean {
    const baseDir = path.resolve(this.repoRoot, this.worktreesBaseDir);
    return wtPath !== this.repoRoot && path.resolve(wtPath).startsWith(baseDir + path.sep);
  }

  /**
   * Lists linked worktrees TaskForge owns. Worktrees created by the user
   * (anywhere outside the configured worktrees dir) are never included.
   */
  async listManagedWorktrees(): Promise<string[]> {
    const res = await ProcessRunner.run({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: this.repoRoot,
    });
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter((p) => this.isManagedPath(p));
  }

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

    await this.linkDependencyDirs(targetPath);

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
          if (this.isManagedPath(wtPath)) {
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

  /**
   * Age-based garbage collection for artifacts left behind by interrupted or
   * crashed sessions. Only touches TaskForge-owned artifacts: worktrees under
   * the configured worktrees dir, leftover directories there, and temporary
   * `taskforge/TASK-*` / `taskforge/integration-*` branches. Run integration
   * branches (`taskforge/run-*`) and delivery branches are never removed.
   * Worktrees owned by this process are skipped.
   */
  async pruneStale(options: PruneStaleOptions): Promise<PruneStaleReport> {
    const now = options.now ?? Date.now();
    const cutoff = now - options.olderThanMs;
    const dryRun = Boolean(options.dryRun);
    const baseDir = path.resolve(this.repoRoot, this.worktreesBaseDir);
    const report: PruneStaleReport = { worktrees: [], directories: [], branches: [], dryRun };
    const active = new Set([...this.activeWorktrees.values()].map((w) => w.path));
    const isStale = (p: string): boolean => {
      try {
        return fs.statSync(p).mtimeMs <= cutoff;
      } catch {
        return true; // path already gone: git only holds a dangling record
      }
    };

    // 1. Linked worktrees inside the TaskForge worktrees dir.
    const list = await ProcessRunner.run({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: this.repoRoot,
    });
    const knownPaths = new Set<string>();
    const liveBranches = new Set<string>();
    if (list.exitCode === 0) {
      let current: { path?: string; branch?: string } = {};
      const flush = async (): Promise<void> => {
        const wtPath = current.path;
        if (wtPath && wtPath !== this.repoRoot && wtPath.startsWith(baseDir + path.sep)) {
          knownPaths.add(wtPath);
          if (!active.has(wtPath) && isStale(wtPath)) {
            report.worktrees.push(wtPath);
            if (!dryRun) {
              await ProcessRunner.run({
                command: 'git',
                args: ['worktree', 'remove', '--force', wtPath],
                cwd: this.repoRoot,
              }).catch(() => {});
              fs.rmSync(wtPath, { recursive: true, force: true });
            }
          } else if (current.branch) {
            liveBranches.add(current.branch);
          }
        }
        current = {};
      };
      for (const line of list.stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          await flush();
          current.path = line.slice('worktree '.length).trim();
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice('branch refs/heads/'.length).trim();
        }
      }
      await flush();
    }
    if (!dryRun) await this.prune().catch(() => {});

    // 2. Leftover directories that git no longer knows about (task/assignment layout).
    if (fs.existsSync(baseDir)) {
      for (const taskDir of fs.readdirSync(baseDir)) {
        const taskPath = path.join(baseDir, taskDir);
        if (!fs.statSync(taskPath).isDirectory()) continue;
        for (const assignmentDir of fs.readdirSync(taskPath)) {
          const wtPath = path.join(taskPath, assignmentDir);
          if (knownPaths.has(wtPath) || active.has(wtPath) || !isStale(wtPath)) continue;
          report.directories.push(wtPath);
          if (!dryRun) fs.rmSync(wtPath, { recursive: true, force: true });
        }
        if (!dryRun && fs.readdirSync(taskPath).length === 0) fs.rmdirSync(taskPath);
      }
    }

    // 3. Temporary branches with no live worktree and no recent commit.
    const refs = await ProcessRunner.run({
      command: 'git',
      args: ['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/taskforge/'],
      cwd: this.repoRoot,
    });
    if (refs.exitCode === 0) {
      for (const line of refs.stdout.split('\n').filter(Boolean)) {
        const [name, unix] = line.split(' ');
        const isTemporary =
          name.startsWith('taskforge/TASK-') || name.startsWith('taskforge/integration-');
        if (!isTemporary || liveBranches.has(name)) continue;
        if (Number(unix) * 1000 > cutoff) continue;
        report.branches.push(name);
        if (!dryRun) {
          await ProcessRunner.run({
            command: 'git',
            args: ['branch', '-D', name],
            cwd: this.repoRoot,
          }).catch(() => {});
        }
      }
    }
    return report;
  }
}
