import { randomUUID } from 'node:crypto';
import { DeliveryError } from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';
import { EventRepository, RunRepository } from '@taskforge/persistence';

export type DeliveryStatus = 'pending' | 'ready_to_apply' | 'applied' | 'pr_created' | 'discarded';

export interface DeliveryMetadata {
  status: DeliveryStatus;
  branch: string;
  targetBranch: string;
  baseCommit: string;
  appliedAt?: string;
  appliedCommit?: string;
  prUrl?: string;
}

export interface ApplyPreflightResult {
  runId: string;
  sourceBranch: string;
  targetBranch: string;
  workingTreeClean: boolean;
  alreadyApplied: boolean;
  hasDiverged: boolean;
  wouldConflict: boolean;
  conflictingFiles: string[];
  diffStat: string;
}

function parseDelivery(metadataJson?: string): DeliveryMetadata | undefined {
  if (!metadataJson) return undefined;
  const parsed = JSON.parse(metadataJson) as { delivery?: DeliveryMetadata };
  return parsed.delivery;
}

export class DeliveryService {
  constructor(
    private repoRoot: string,
    private gitService: GitService,
    private runRepo: RunRepository,
    private eventRepo?: EventRepository,
  ) {}

  getDelivery(runId: string): DeliveryMetadata | undefined {
    const run = this.runRepo.get(runId);
    return parseDelivery(run?.metadataJson);
  }

  findLatestReady(): { runId: string; delivery: DeliveryMetadata } | undefined {
    const runs = this.runRepo.listAll();
    for (const run of runs) {
      const delivery = parseDelivery(run.metadataJson);
      if (delivery?.status === 'ready_to_apply') {
        return { runId: run.id, delivery };
      }
    }
    return undefined;
  }

  markReady(runId: string, branch: string, targetBranch: string, baseCommit: string): void {
    const delivery: DeliveryMetadata = {
      status: 'ready_to_apply',
      branch,
      targetBranch,
      baseCommit,
    };
    this.runRepo.mergeMetadata(runId, { delivery });
    this.eventRepo?.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'DELIVERY_READY',
      payload: { branch, targetBranch },
      timestamp: new Date(),
    });
  }

  private requireDelivery(runId: string): DeliveryMetadata {
    const delivery = this.getDelivery(runId);
    if (!delivery) {
      throw new DeliveryError(`Run ${runId} has no delivery information`, { runId });
    }
    return delivery;
  }

  private static extractConflictFiles(uncommittedFiles: string[]): string[] {
    return uncommittedFiles
      .filter((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line))
      .map((line) => line.slice(3).trim());
  }

  async preflight(runId: string): Promise<ApplyPreflightResult> {
    const delivery = this.requireDelivery(runId);
    // Exclude TaskForge's own state directory: its database, worktrees and run
    // logs commonly live inside the repo and shouldn't count as "dirty" for
    // the purpose of an apply preflight.
    const status = await this.gitService.getStatus(this.repoRoot, ['.taskforge']);
    const alreadyApplied = await this.gitService.isAncestor(
      delivery.branch,
      delivery.targetBranch,
    );
    // Divergence must be measured against targetBranch's own HEAD, not
    // whatever branch happens to be checked out in the working tree.
    const targetHeadCommit = await this.gitService.resolveRef(
      delivery.targetBranch,
      this.repoRoot,
    );
    const hasDiverged = targetHeadCommit !== delivery.baseCommit;

    let wouldConflict = false;
    let conflictingFiles: string[] = [];

    if (!alreadyApplied && status.isClean) {
      const originalBranch = status.currentBranch;
      const needsCheckout = originalBranch !== delivery.targetBranch;
      try {
        if (needsCheckout) {
          await this.gitService.checkout(delivery.targetBranch, this.repoRoot);
        }
        try {
          await this.gitService.merge(
            delivery.branch,
            { noFf: true, noCommit: true },
            this.repoRoot,
          );
          await this.gitService.mergeAbort(this.repoRoot);
        } catch {
          const conflictStatus = await this.gitService.getStatus(this.repoRoot);
          conflictingFiles = DeliveryService.extractConflictFiles(conflictStatus.uncommittedFiles);
          wouldConflict = true;
          await this.gitService.mergeAbort(this.repoRoot);
        }
      } finally {
        if (needsCheckout) {
          await this.gitService.checkout(originalBranch, this.repoRoot);
        }
      }
    }

    const diffStat = await this.gitService
      .diffStat(delivery.targetBranch, delivery.branch, this.repoRoot)
      .catch(() => '');

    return {
      runId,
      sourceBranch: delivery.branch,
      targetBranch: delivery.targetBranch,
      workingTreeClean: status.isClean,
      alreadyApplied,
      hasDiverged,
      wouldConflict,
      conflictingFiles,
      diffStat,
    };
  }

  async apply(runId: string): Promise<{ commit: string; alreadyApplied: boolean }> {
    // Note: permissions.git.merge_main gates whether an *agent* may request a
    // merge_main action during a run (see PermissionEngine); it does not gate
    // this explicit, human-invoked delivery command. The RunOrchestrator's
    // `auto_apply` delivery mode checks that permission before ever calling
    // apply() automatically, so unattended merges still require an explicit
    // opt-in, while a manual /apply always works.
    const delivery = this.requireDelivery(runId);
    const preflight = await this.preflight(runId);

    if (preflight.alreadyApplied) {
      return { commit: delivery.appliedCommit ?? delivery.baseCommit, alreadyApplied: true };
    }

    if (!preflight.workingTreeClean) {
      throw new DeliveryError('Working tree is not clean; commit or stash your changes first', {
        runId,
      });
    }

    if (preflight.wouldConflict) {
      this.eventRepo?.append({
        id: `evt-${randomUUID()}`,
        runId,
        type: 'DELIVERY_CONFLICT',
        payload: { conflictingFiles: preflight.conflictingFiles },
        timestamp: new Date(),
      });
      throw new DeliveryError(
        `Merging ${delivery.branch} into ${delivery.targetBranch} would conflict`,
        { runId, conflictingFiles: preflight.conflictingFiles },
      );
    }

    // The merge must land on targetBranch itself, never on whatever branch
    // the operator happens to have checked out; restore it afterward so
    // /apply never disturbs the caller's working context.
    const status = await this.gitService.getStatus(this.repoRoot, ['.taskforge']);
    const originalBranch = status.currentBranch;
    const needsCheckout = originalBranch !== delivery.targetBranch;

    let commit: string;
    try {
      if (needsCheckout) {
        await this.gitService.checkout(delivery.targetBranch, this.repoRoot);
      }
      commit = await this.gitService.merge(
        delivery.branch,
        { noFf: true, message: `Merge TaskForge run ${runId}` },
        this.repoRoot,
      );
    } finally {
      if (needsCheckout) {
        await this.gitService.checkout(originalBranch, this.repoRoot);
      }
    }

    this.runRepo.mergeMetadata(runId, {
      delivery: {
        ...delivery,
        status: 'applied' as DeliveryStatus,
        appliedAt: new Date().toISOString(),
        appliedCommit: commit,
      },
    });
    this.eventRepo?.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'DELIVERY_APPLIED',
      payload: { commit, targetBranch: delivery.targetBranch },
      timestamp: new Date(),
    });

    return { commit, alreadyApplied: false };
  }

  async diff(runId: string): Promise<string> {
    const delivery = this.requireDelivery(runId);
    return this.gitService.diffStat(delivery.targetBranch, delivery.branch, this.repoRoot);
  }

  discard(runId: string): void {
    const delivery = this.requireDelivery(runId);
    this.runRepo.mergeMetadata(runId, {
      delivery: { ...delivery, status: 'discarded' as DeliveryStatus },
    });
    this.eventRepo?.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'DELIVERY_DISCARDED',
      payload: {},
      timestamp: new Date(),
    });
  }

  markPrCreated(runId: string, prUrl: string): void {
    const delivery = this.requireDelivery(runId);
    this.runRepo.mergeMetadata(runId, {
      delivery: { ...delivery, status: 'pr_created' as DeliveryStatus, prUrl },
    });
    this.eventRepo?.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'DELIVERY_PR_CREATED',
      payload: { prUrl },
      timestamp: new Date(),
    });
  }
}
