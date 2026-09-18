import { GitService, WorktreeManager } from '@taskforge/workspace';
import { EventRepository } from '@taskforge/persistence';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationError, TaskForgeConfig } from '@taskforge/shared';

export interface IntegrateTaskOptions {
  runId: string;
  taskId: string;
  commitHash: string;
  baseCommit: string;
}

export class IntegrationService {
  constructor(
    private repoRoot: string,
    private gitService: GitService,
    private worktreeManager: WorktreeManager,
    private verificationRunner?: VerificationRunner,
    private eventRepo?: EventRepository,
  ) {}

  private branchInitPromise?: Promise<string>;
  private queueLock: Promise<void> = Promise.resolve();

  getBranchName(runId: string): string {
    return `taskforge/run-${runId}`;
  }

  async initIntegrationBranch(runId: string, baseCommit: string): Promise<string> {
    if (!this.branchInitPromise) {
      this.branchInitPromise = (async () => {
        const branchName = this.getBranchName(runId);
        const exists = await this.gitService.branchExists(branchName);
        if (!exists) {
          try {
            await this.gitService.createBranch(branchName, baseCommit);
          } catch (err) {
            if (!(err as Error).message.includes('already exists')) {
              throw err;
            }
          }
        }
        return branchName;
      })();
    }
    return this.branchInitPromise;
  }

  async integrateTaskCommit(options: IntegrateTaskOptions): Promise<string> {
    const { runId, taskId, commitHash, baseCommit } = options;

    // Chain execution sequentially to prevent concurrent Git operations on integration branch
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = this.queueLock;
    this.queueLock = currentLock;

    await previousLock;

    try {
      const branchName = await this.initIntegrationBranch(runId, baseCommit);
      const wt = await this.worktreeManager.createWorktree(
        `integration-${runId}`,
        'main-worker',
        branchName,
      );

      const currentHead = await this.gitService.getHeadCommit(wt.path);
      if (commitHash === currentHead || commitHash === baseCommit) {
        return currentHead;
      }

      // Cherry pick the commit into the integration branch worktree
      const newHead = await this.gitService.cherryPick(commitHash, wt.path);
      await this.gitService.execGit(['update-ref', `refs/heads/${branchName}`, newHead]);
      return newHead;
    } catch (err) {
      const branchName = this.getBranchName(runId);
      const wt = this.worktreeManager.getWorktree(`integration-${runId}`, 'main-worker');
      if (wt) {
        await this.gitService.abortCherryPick(wt.path).catch(() => {});
      }
      throw new IntegrationError(
        `Failed to integrate task ${taskId} (commit ${commitHash}) into ${branchName}: ${(err as Error).message}`,
        { runId, taskId, commitHash, branchName, error: err },
      );
    } finally {
      releaseLock();
    }
  }

  async finalizeRun(
    runId: string,
    config: TaskForgeConfig,
    baseCommit: string,
  ): Promise<{ branchName: string; verified: boolean }> {
    const branchName = this.getBranchName(runId);
    const wt = await this.worktreeManager.createWorktree(`integration-${runId}`, 'main-worker', branchName);

    let verified = true;
    if (this.verificationRunner && config.verification.tests) {
      const verResult = await this.verificationRunner.verify({
        taskId: `FINAL-${runId}`,
        runId,
        worktreePath: wt.path,
        config,
      });
      verified = verResult.passed;
      if (!verified) {
        throw new IntegrationError(
          `Final integration verification failed for branch ${branchName}: ${verResult.failureReason}`,
          { runId, branchName, failureReason: verResult.failureReason },
        );
      }
    }

    if (this.eventRepo) {
      this.eventRepo.append({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        runId,
        type: 'INTEGRATION_COMPLETED',
        payload: {
          branchName,
          baseCommit,
          verified,
        },
        timestamp: new Date(),
      });
    }

    return {
      branchName,
      verified,
    };
  }
}
