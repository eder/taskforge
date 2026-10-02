import { randomUUID } from 'node:crypto';
import { DeliveryError } from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';
import { slugifyGoal } from '@taskforge/git-workflow';
import { EventRepository, RunRepository } from '@taskforge/persistence';

export type DeliveryStatus =
  | 'pending'
  | 'ready_to_apply'
  | 'applied'
  | 'pr_created'
  | 'discarded'
  | 'reverted';

export interface DeliveryMetadata {
  status: DeliveryStatus;
  branch: string;
  targetBranch: string;
  baseCommit: string;
  appliedAt?: string;
  appliedCommit?: string;
  /** Set by undo(): the commit that reverses appliedCommit. */
  revertCommit?: string;
  revertedAt?: string;
  prUrl?: string;
  /** Human-readable branch the PR is opened from (see prepareDeliveryBranch). */
  deliveryBranch?: string;
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

  /** The most recently applied run that has not been undone. */
  findLatestApplied(): { runId: string; delivery: DeliveryMetadata } | undefined {
    for (const run of this.runRepo.listAll()) {
      const delivery = parseDelivery(run.metadataJson);
      if (delivery?.status === 'applied' && delivery.appliedCommit) return { runId: run.id, delivery };
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
    if (!(await this.gitService.branchExists(delivery.targetBranch))) {
      throw new DeliveryError(
        `Target branch "${delivery.targetBranch}" does not exist in this repository. Create it, or set git.targetBranch / delivery.targetBranch in .taskforge/config.yaml.`,
        { runId, targetBranch: delivery.targetBranch },
      );
    }
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

  /**
   * Reverses an applied run with a new commit (`git revert`), so nothing is
   * rewritten or lost and it is safe even if the change was already pushed.
   * Refuses when the working tree is dirty or the run was not applied, and
   * leaves the repository untouched if the revert would conflict with work
   * done since. To bring the change back, revert the returned commit.
   */
  async undo(runId: string): Promise<{ revertCommit: string; appliedCommit: string }> {
    const delivery = this.requireDelivery(runId);
    if (delivery.status === 'reverted') {
      throw new DeliveryError(`Run ${runId} was already undone (by ${delivery.revertCommit?.slice(0, 7) ?? 'a revert commit'})`, { runId });
    }
    const applied = delivery.appliedCommit;
    if (delivery.status !== 'applied' || !applied) {
      throw new DeliveryError(`Run ${runId} was not applied, so there is nothing to undo`, { runId });
    }

    const git = this.gitService;
    const status = await git.getStatus(this.repoRoot, ['.taskforge']);
    if (status.uncommittedFiles.length > 0) {
      throw new DeliveryError('Working tree is not clean; commit or stash your changes first', { runId });
    }
    try {
      await git.exec(['merge-base', '--is-ancestor', applied, delivery.targetBranch], this.repoRoot);
    } catch {
      throw new DeliveryError(
        `${applied.slice(0, 7)} is not on ${delivery.targetBranch} any more (history was rewritten?), so it cannot be reverted automatically`,
        { runId },
      );
    }

    const parents = (await git.exec(['rev-list', '--parents', '-n', '1', applied], this.repoRoot))
      .trim()
      .split(/\s+/)
      .slice(1);
    const mainline = parents.length > 1 ? ['-m', '1'] : [];

    const originalBranch = status.currentBranch;
    const needsCheckout = originalBranch !== delivery.targetBranch;
    let revertCommit: string;
    try {
      if (needsCheckout) await git.checkout(delivery.targetBranch, this.repoRoot);
      try {
        await git.exec(['revert', ...mainline, '--no-edit', applied], this.repoRoot);
      } catch (err) {
        await git.exec(['revert', '--abort'], this.repoRoot).catch(() => undefined);
        throw new DeliveryError(
          `Reverting ${applied.slice(0, 7)} would conflict with changes made since. Nothing was changed; resolve it by hand with: git revert ${mainline.join(' ')} ${applied.slice(0, 7)}`.replace(/\s+/g, ' '),
          { runId, cause: (err as Error).message },
        );
      }
      revertCommit = (await git.exec(['rev-parse', 'HEAD'], this.repoRoot)).trim();
    } finally {
      if (needsCheckout) await git.checkout(originalBranch, this.repoRoot).catch(() => undefined);
    }

    this.runRepo.mergeMetadata(runId, {
      delivery: {
        ...delivery,
        status: 'reverted' as DeliveryStatus,
        revertedAt: new Date().toISOString(),
        revertCommit,
      },
    });
    this.eventRepo?.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'DELIVERY_REVERTED',
      payload: { appliedCommit: applied, revertCommit, targetBranch: delivery.targetBranch },
      timestamp: new Date(),
    });
    return { revertCommit, appliedCommit: applied };
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

  /**
   * Creates (or reuses) a human-readable delivery branch, `taskforge/<goal-slug>`,
   * pointing at the run's integration branch. PRs open from this branch instead
   * of the ephemeral `taskforge/run-<id>` one. Returns undefined when the run
   * has no delivery information, so callers can fall back to the run branch.
   */
  async prepareDeliveryBranch(runId: string): Promise<string | undefined> {
    const delivery = this.getDelivery(runId);
    if (!delivery) return undefined;

    const integrationHead = await this.gitService.resolveRef(delivery.branch, this.repoRoot);

    if (delivery.deliveryBranch && (await this.gitService.branchExists(delivery.deliveryBranch))) {
      const head = await this.gitService.resolveRef(delivery.deliveryBranch, this.repoRoot);
      if (head === integrationHead) return delivery.deliveryBranch;
    }

    const metadata = this.runRepo.get(runId)?.metadataJson;
    const goalDescription = metadata
      ? (JSON.parse(metadata) as { goalDescription?: string }).goalDescription
      : undefined;
    const base = `taskforge/${slugifyGoal(goalDescription ?? '')}`;

    let name = base;
    for (let suffix = 2; await this.gitService.branchExists(name); suffix++) {
      const existingHead = await this.gitService.resolveRef(name, this.repoRoot);
      if (existingHead === integrationHead) break; // same content: reuse
      name = `${base}-${suffix}`;
    }
    if (!(await this.gitService.branchExists(name))) {
      await this.gitService.createBranch(name, delivery.branch);
    }

    this.runRepo.mergeMetadata(runId, { delivery: { ...delivery, deliveryBranch: name } });
    this.eventRepo?.append({
      id: `evt-${randomUUID()}`,
      runId,
      type: 'DELIVERY_BRANCH_CREATED',
      payload: { deliveryBranch: name, sourceBranch: delivery.branch },
      timestamp: new Date(),
    });
    return name;
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
