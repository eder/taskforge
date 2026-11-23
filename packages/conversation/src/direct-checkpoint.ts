import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { GitService } from '@taskforge/workspace';

const execFileAsync = promisify(execFile);

export interface DirectCheckpoint {
  id: string;
  label: string;
  agentId: string;
  createdAt: string;
  baseHead: string;
  treeHash: string;
  indexTreeHash: string;
  commitHash: string;
  refName: string;
  /** Populated after the turn completes with the files touched by that turn. */
  filesTouched?: string[];
}

export interface RestoreCheckpointResult {
  success: boolean;
  checkpoint?: DirectCheckpoint;
  restoredFiles: string[];
  removedFiles: string[];
  remainingCount: number;
  error?: string;
}

const CHECKPOINT_REF_PREFIX = 'refs/taskforge/checkpoints/';

/**
 * Captures and restores lightweight, non-destructive Git tree checkpoints before
 * Direct Mode write turns so `/undo` (or "desfaz") restores the working tree in
 * under a second without touching `git stash list` or rewriting git history.
 */
export class DirectCheckpointManager {
  private checkpoints: DirectCheckpoint[] = [];
  private readonly maxCheckpoints: number;
  private readonly git: GitService;

  constructor(
    private readonly repoRoot: string,
    gitService?: GitService,
    maxCheckpoints = 20,
  ) {
    this.git = gitService ?? new GitService(repoRoot);
    this.maxCheckpoints = maxCheckpoints;
  }

  private async runGit(args: string[], envOverrides?: Record<string, string>): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.repoRoot,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  public list(): readonly DirectCheckpoint[] {
    return this.checkpoints;
  }

  public getLatest(): DirectCheckpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  public exportState(): DirectCheckpoint[] {
    return this.checkpoints.map((cp) => ({
      ...cp,
      ...(cp.filesTouched ? { filesTouched: [...cp.filesTouched] } : {}),
    }));
  }

  public restoreState(items: unknown[]): void {
    this.checkpoints = [];
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Partial<DirectCheckpoint>;
      if (
        typeof obj.id === 'string' &&
        typeof obj.baseHead === 'string' &&
        typeof obj.treeHash === 'string' &&
        typeof obj.indexTreeHash === 'string' &&
        typeof obj.commitHash === 'string' &&
        typeof obj.refName === 'string'
      ) {
        this.checkpoints.push({
          id: obj.id,
          label: typeof obj.label === 'string' ? obj.label : 'direct edit',
          agentId: typeof obj.agentId === 'string' ? obj.agentId : 'agent',
          createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
          baseHead: obj.baseHead,
          treeHash: obj.treeHash,
          indexTreeHash: obj.indexTreeHash,
          commitHash: obj.commitHash,
          refName: obj.refName,
          ...(Array.isArray(obj.filesTouched)
            ? { filesTouched: obj.filesTouched.filter((f): f is string => typeof f === 'string') }
            : {}),
        });
      }
    }
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints = this.checkpoints.slice(-this.maxCheckpoints);
    }
  }

  public async clear(): Promise<void> {
    const existing = [...this.checkpoints];
    this.checkpoints = [];
    for (const cp of existing) {
      await this.runGit(['update-ref', '-d', cp.refName]).catch(() => {});
    }
  }

  /**
   * Takes a lossless snapshot of both the working tree (including untracked
   * non-ignored files) and the current staged index without mutating `.git/index`,
   * `HEAD`, or `git stash list`.
   */
  public async capture(label: string, agentId: string): Promise<DirectCheckpoint | undefined> {
    try {
      if (!(await this.git.isGitRepo())) return undefined;
      const baseHead = (await this.runGit(['rev-parse', '--verify', 'HEAD'])).trim();
      if (!baseHead) return undefined;

      // Capture exact current staged index tree so restoring preserves staged/unstaged separation.
      const indexTreeHash = (await this.runGit(['write-tree'])).trim();

      // Build working-tree snapshot inside a temporary index file.
      const tmpIndex = path.join(os.tmpdir(), `tf-ckpt-idx-${process.pid}-${randomUUID().slice(0, 8)}`);
      let treeHash = '';
      try {
        await this.runGit(['read-tree', baseHead], { GIT_INDEX_FILE: tmpIndex });
        await this.runGit(['add', '-A'], { GIT_INDEX_FILE: tmpIndex });
        treeHash = (await this.runGit(['write-tree'], { GIT_INDEX_FILE: tmpIndex })).trim();
      } finally {
        fs.rmSync(tmpIndex, { force: true });
      }

      if (!treeHash) return undefined;

      const id = `cp-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
      const shortLabel = label.replace(/\s+/g, ' ').trim().slice(0, 80) || 'direct edit';
      const commitHash = (
        await this.runGit(
          ['commit-tree', treeHash, '-p', baseHead, '-m', `taskforge-checkpoint(${agentId}): ${shortLabel}`],
          {
            GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'TaskForge',
            GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'taskforge@local',
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'TaskForge',
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'taskforge@local',
          },
        )
      ).trim();

      const refName = `${CHECKPOINT_REF_PREFIX}${id}`;
      await this.runGit(['update-ref', refName, commitHash]);

      const checkpoint: DirectCheckpoint = {
        id,
        label: shortLabel,
        agentId,
        createdAt: new Date().toISOString(),
        baseHead,
        treeHash,
        indexTreeHash,
        commitHash,
        refName,
      };
      this.checkpoints.push(checkpoint);

      // Evict oldest checkpoints beyond capacity.
      while (this.checkpoints.length > this.maxCheckpoints) {
        const evicted = this.checkpoints.shift();
        if (evicted) {
          await this.runGit(['update-ref', '-d', evicted.refName]).catch(() => {});
        }
      }

      return checkpoint;
    } catch {
      return undefined;
    }
  }

  /** Attaches the list of files touched after the turn finishes. */
  public annotateFilesTouched(id: string, files: string[]): void {
    const cp = this.checkpoints.find((c) => c.id === id);
    if (cp) {
      cp.filesTouched = [...new Set(files)];
    }
  }

  /** Discards a checkpoint (e.g. when a turn made no working-tree changes). */
  public async discard(id: string): Promise<void> {
    const idx = this.checkpoints.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const [removed] = this.checkpoints.splice(idx, 1);
    await this.runGit(['update-ref', '-d', removed.refName]).catch(() => {});
  }

  /**
   * Restores the most recent checkpoint (or a specific checkpoint ID), bringing
   * both working-tree files and staged index back to the exact pre-turn state.
   */
  public async restoreLatest(targetId?: string): Promise<RestoreCheckpointResult> {
    if (this.checkpoints.length === 0) {
      return {
        success: false,
        restoredFiles: [],
        removedFiles: [],
        remainingCount: 0,
        error: 'No direct-mode checkpoint available to undo.',
      };
    }

    const idx = targetId
      ? this.checkpoints.findIndex((c) => c.id === targetId)
      : this.checkpoints.length - 1;
    if (idx < 0) {
      return {
        success: false,
        restoredFiles: [],
        removedFiles: [],
        remainingCount: this.checkpoints.length,
        error: `Checkpoint "${targetId}" not found.`,
      };
    }

    const checkpoint = this.checkpoints[idx];

    try {
      const currentHead = (await this.runGit(['rev-parse', '--verify', 'HEAD'])).trim();
      if (currentHead !== checkpoint.baseHead) {
        return {
          success: false,
          checkpoint,
          restoredFiles: [],
          removedFiles: [],
          remainingCount: this.checkpoints.length,
          error: `HEAD moved (${checkpoint.baseHead.slice(0, 7)} → ${currentHead.slice(0, 7)}) since checkpoint "${checkpoint.label}". Refusing to overwrite commits; use git revert instead.`,
        };
      }

      // Verify tree object still exists.
      await this.runGit(['cat-file', '-e', `${checkpoint.treeHash}^{tree}`]);

      // Determine all files that existed in the checkpoint tree.
      const checkpointTreeRaw = await this.runGit(['ls-tree', '-r', '--name-only', checkpoint.treeHash]);
      const checkpointFiles = new Set(
        checkpointTreeRaw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );

      // Determine which files changed since the checkpoint (tracked + untracked).
      const diffAgainstCkptRaw = await this.runGit(['diff', '--name-only', checkpoint.treeHash]).catch(
        () => '',
      );
      const untrackedNowRaw = await this.runGit(['ls-files', '--others', '--exclude-standard']).catch(
        () => '',
      );
      const stagedNowRaw = await this.runGit(['diff', '--cached', '--name-only', checkpoint.treeHash]).catch(
        () => '',
      );

      const untrackedNow = untrackedNowRaw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const removedFiles: string[] = [];

      // Remove untracked files created after the checkpoint.
      for (const rel of untrackedNow) {
        if (!checkpointFiles.has(rel) && !rel.startsWith('.taskforge/')) {
          const full = path.join(this.repoRoot, rel);
          if (fs.existsSync(full)) {
            fs.rmSync(full, { recursive: true, force: true });
            removedFiles.push(rel);
          }
        }
      }

      // Restore working tree + index to the checkpoint tree snapshot.
      await this.runGit(['read-tree', '--reset', '-u', checkpoint.treeHash]);

      // Restore exact pre-turn index state (without touching working tree files!).
      await this.runGit(['read-tree', checkpoint.indexTreeHash]);

      const restoredSet = new Set<string>([
        ...diffAgainstCkptRaw.split('\n').map((l) => l.trim()).filter(Boolean),
        ...stagedNowRaw.split('\n').map((l) => l.trim()).filter(Boolean),
        ...(checkpoint.filesTouched ?? []),
      ]);
      for (const rm of removedFiles) restoredSet.delete(rm);

      // Pop restored checkpoint (and any newer ones if restoring an older id).
      const popped = this.checkpoints.splice(idx);
      for (const cp of popped) {
        await this.runGit(['update-ref', '-d', cp.refName]).catch(() => {});
      }

      return {
        success: true,
        checkpoint,
        restoredFiles: [...restoredSet],
        removedFiles,
        remainingCount: this.checkpoints.length,
      };
    } catch (err) {
      return {
        success: false,
        checkpoint,
        restoredFiles: [],
        removedFiles: [],
        remainingCount: this.checkpoints.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
