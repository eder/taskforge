import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskForgeDatabase, RunRepository, EventRepository } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { DeliveryService } from '../src/delivery-service.js';

interface DeliverySandbox {
  repoRoot: string;
  gitService: GitService;
  baseCommit: string;
  db: TaskForgeDatabase;
  runRepo: RunRepository;
  service: DeliveryService;
  createIntegrationBranch: (runId: string, fileName: string, content: string) => Promise<string>;
}

async function withDeliverySandbox<T>(fn: (s: DeliverySandbox) => Promise<T>): Promise<T> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-delivery-'));
  const gitService = new GitService(repoRoot);
  await gitService.exec(['init', '-b', 'main'], repoRoot);
  await gitService.exec(['config', 'user.name', 'TaskForge Delivery Bot'], repoRoot);
  await gitService.exec(['config', 'user.email', 'delivery@taskforge.dev'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'shared.txt'), 'line one\nline two\nline three\n');
  const baseCommit = await gitService.stageAndCommit('Initial commit', repoRoot);

  const db = new TaskForgeDatabase(':memory:');
  const runRepo = new RunRepository(db);
  const eventRepo = new EventRepository(db);
  const service = new DeliveryService(repoRoot, gitService, runRepo, eventRepo);

  const createIntegrationBranch = async (runId: string, fileName: string, content: string) => {
    const branch = `taskforge/${runId}`;
    await gitService.createBranch(branch, baseCommit);
    await gitService.checkout(branch, repoRoot);
    fs.writeFileSync(path.join(repoRoot, fileName), content);
    await gitService.stageAndCommit(`feat: ${fileName}`, repoRoot);
    await gitService.checkout('main', repoRoot);
    return branch;
  };

  try {
    return await fn({
      repoRoot,
      gitService,
      baseCommit,
      db,
      runRepo,
      service,
      createIntegrationBranch,
    });
  } finally {
    db.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe.concurrent('DeliveryService', () => {
  it('applies a ready run cleanly and reports the merge commit', async () => {
    await withDeliverySandbox(async ({ repoRoot, baseCommit, runRepo, service, createIntegrationBranch }) => {
      const runId = 'run-apply-happy';
      runRepo.create(runId);
      const branch = await createIntegrationBranch(runId, 'feature.txt', 'new feature\n');
      service.markReady(runId, branch, 'main', baseCommit);

      const result = await service.apply(runId);

      expect(result.alreadyApplied).toBe(false);
      expect(fs.existsSync(path.join(repoRoot, 'feature.txt'))).toBe(true);
      expect(service.getDelivery(runId)?.status).toBe('applied');
      expect(service.getDelivery(runId)?.appliedCommit).toBe(result.commit);
    });
  });

  it('is idempotent when applying an already-applied run again', async () => {
    await withDeliverySandbox(async ({ baseCommit, runRepo, service, createIntegrationBranch }) => {
      const runId = 'run-apply-twice';
      runRepo.create(runId);
      const branch = await createIntegrationBranch(runId, 'feature2.txt', 'new feature 2\n');
      service.markReady(runId, branch, 'main', baseCommit);

      const first = await service.apply(runId);
      const second = await service.apply(runId);

      expect(first.alreadyApplied).toBe(false);
      expect(second.alreadyApplied).toBe(true);
    });
  });

  it('refuses to apply when the working tree is dirty', async () => {
    await withDeliverySandbox(async ({ repoRoot, baseCommit, runRepo, service, createIntegrationBranch }) => {
      const runId = 'run-apply-dirty';
      runRepo.create(runId);
      const branch = await createIntegrationBranch(runId, 'feature3.txt', 'new feature 3\n');
      service.markReady(runId, branch, 'main', baseCommit);

      fs.writeFileSync(path.join(repoRoot, 'uncommitted.txt'), 'oops\n');

      await expect(service.apply(runId)).rejects.toThrow(/not clean/);
    });
  });

  it('detects a conflicting merge, aborts cleanly, and never touches the target branch', async () => {
    await withDeliverySandbox(async ({ repoRoot, gitService, baseCommit, runRepo, service, createIntegrationBranch }) => {
      const runId = 'run-apply-conflict';
      runRepo.create(runId);
      const branch = await createIntegrationBranch(
        runId,
        'shared.txt',
        'line one\nCHANGED BY AGENT\nline three\n',
      );

      fs.writeFileSync(
        path.join(repoRoot, 'shared.txt'),
        'line one\nCHANGED BY HUMAN\nline three\n',
      );
      const mainHeadBeforeApply = await gitService.stageAndCommit(
        'chore: conflicting human edit',
        repoRoot,
      );

      service.markReady(runId, branch, 'main', baseCommit);

      await expect(service.apply(runId)).rejects.toMatchObject({
        context: { conflictingFiles: ['shared.txt'] },
      });

      const status = await gitService.getStatus(repoRoot);
      expect(status.isClean).toBe(true);
      expect(status.headCommit).toBe(mainHeadBeforeApply);
      expect(service.getDelivery(runId)?.status).toBe('ready_to_apply');
    });
  });

  it('merges into targetBranch even when a different branch is currently checked out', async () => {
    await withDeliverySandbox(async ({ repoRoot, gitService, baseCommit, runRepo, service, createIntegrationBranch }) => {
      const runId = 'run-apply-other-branch-checked-out';
      runRepo.create(runId);
      const branch = await createIntegrationBranch(runId, 'feature4.txt', 'new feature 4\n');
      service.markReady(runId, branch, 'main', baseCommit);

      await gitService.createBranch('feature/my-work', baseCommit);
      await gitService.checkout('feature/my-work', repoRoot);
      fs.writeFileSync(path.join(repoRoot, 'wip.txt'), 'work in progress\n');
      const featureCommit = await gitService.stageAndCommit('wip: unrelated work', repoRoot);

      const result = await service.apply(runId);

      expect(result.alreadyApplied).toBe(false);

      const statusAfter = await gitService.getStatus(repoRoot);
      expect(statusAfter.currentBranch).toBe('feature/my-work');
      expect(statusAfter.headCommit).toBe(featureCommit);
      expect(statusAfter.isClean).toBe(true);
      expect(fs.existsSync(path.join(repoRoot, 'feature4.txt'))).toBe(false);

      const mainHead = await gitService.resolveRef('main', repoRoot);
      expect(mainHead).toBe(result.commit);
      expect(mainHead).not.toBe(featureCommit);
    });
  });

  describe.concurrent('prepareDeliveryBranch', () => {
    it('creates a goal-slug branch at the integration head and persists it', async () => {
      await withDeliverySandbox(async ({ repoRoot, gitService, baseCommit, runRepo, service, createIntegrationBranch }) => {
        const runId = 'run-delivery-slug';
        runRepo.create(runId, undefined, { goalDescription: 'Add commitment intelligence' });
        const branch = await createIntegrationBranch(runId, 'ci.txt', 'ci\n');
        service.markReady(runId, branch, 'main', baseCommit);

        const name = await service.prepareDeliveryBranch(runId);

        expect(name).toBe('taskforge/commitment-intelligence');
        expect(await gitService.resolveRef(name!, repoRoot)).toBe(
          await gitService.resolveRef(branch, repoRoot),
        );
        expect(service.getDelivery(runId)?.deliveryBranch).toBe(name);
        expect(await service.prepareDeliveryBranch(runId)).toBe(name);
      });
    });

    it('suffixes the name when the slug is taken by different content', async () => {
      await withDeliverySandbox(async ({ baseCommit, runRepo, service, createIntegrationBranch }) => {
        runRepo.create('run-a', undefined, { goalDescription: 'Add search' });
        runRepo.create('run-b', undefined, { goalDescription: 'Add search' });
        const branchA = await createIntegrationBranch('run-a', 'a.txt', 'a\n');
        const branchB = await createIntegrationBranch('run-b', 'b.txt', 'b\n');
        service.markReady('run-a', branchA, 'main', baseCommit);
        service.markReady('run-b', branchB, 'main', baseCommit);

        expect(await service.prepareDeliveryBranch('run-a')).toBe('taskforge/search');
        expect(await service.prepareDeliveryBranch('run-b')).toBe('taskforge/search-2');
      });
    });

    it('returns undefined for a run without delivery information', async () => {
      await withDeliverySandbox(async ({ runRepo, service }) => {
        runRepo.create('run-none');
        expect(await service.prepareDeliveryBranch('run-none')).toBeUndefined();
      });
    });
  });

  describe.concurrent('undo', () => {
    async function applyInSandbox(s: DeliverySandbox, runId: string, file: string) {
      s.runRepo.create(runId);
      const branch = await s.createIntegrationBranch(runId, file, 'content\n');
      s.service.markReady(runId, branch, 'main', s.baseCommit);
      return s.service.apply(runId);
    }

    it('reverses an applied run with a new commit and keeps history', async () => {
      await withDeliverySandbox(async (s) => {
        const result = await applyInSandbox(s, 'run-undo-ok', 'undo-me.txt');
        expect(fs.existsSync(path.join(s.repoRoot, 'undo-me.txt'))).toBe(true);

        const undone = await s.service.undo('run-undo-ok');

        expect(undone.appliedCommit).toBe(result.commit);
        expect(fs.existsSync(path.join(s.repoRoot, 'undo-me.txt'))).toBe(false);
        expect(s.service.getDelivery('run-undo-ok')?.status).toBe('reverted');
        expect(s.service.getDelivery('run-undo-ok')?.revertCommit).toBe(undone.revertCommit);
        await s.gitService.exec(['merge-base', '--is-ancestor', result.commit, 'main'], s.repoRoot);
      });
    });

    it('refuses to undo twice, a run that was never applied, or with a dirty working tree', async () => {
      await withDeliverySandbox(async (s) => {
        await applyInSandbox(s, 'run-undo-guards', 'guard.txt');
        fs.writeFileSync(path.join(s.repoRoot, 'dirty.txt'), 'wip');
        await expect(s.service.undo('run-undo-guards')).rejects.toThrow(/not clean/);
        fs.rmSync(path.join(s.repoRoot, 'dirty.txt'));

        await s.service.undo('run-undo-guards');
        await expect(s.service.undo('run-undo-guards')).rejects.toThrow(/already undone/);

        s.runRepo.create('run-unapplied');
        const branch = await s.createIntegrationBranch('run-unapplied', 'u.txt', 'x\n');
        s.service.markReady('run-unapplied', branch, 'main', s.baseCommit);
        await expect(s.service.undo('run-unapplied')).rejects.toThrow(/nothing to undo/);
      });
    });

    it('leaves the repository untouched when later work conflicts with the revert', async () => {
      await withDeliverySandbox(async (s) => {
        await applyInSandbox(s, 'run-undo-conflict', 'shared-edit.txt');
        fs.writeFileSync(path.join(s.repoRoot, 'shared-edit.txt'), 'someone edited this later\n');
        await s.gitService.stageAndCommit('later edit', s.repoRoot);
        const head = (await s.gitService.exec(['rev-parse', 'HEAD'], s.repoRoot)).trim();

        await expect(s.service.undo('run-undo-conflict')).rejects.toThrow(/would conflict/);

        expect((await s.gitService.exec(['rev-parse', 'HEAD'], s.repoRoot)).trim()).toBe(head);
        expect((await s.gitService.getStatus(s.repoRoot)).uncommittedFiles).toEqual([]);
        expect(s.service.getDelivery('run-undo-conflict')?.status).toBe('applied');
      });
    });

    it('finds the newest applied run that is not undone', async () => {
      await withDeliverySandbox(async (s) => {
        await applyInSandbox(s, 'run-find-1', 'f1.txt');
        expect(s.service.findLatestApplied()?.runId).toBe('run-find-1');
        await s.service.undo('run-find-1');
        expect(s.service.findLatestApplied()).toBeUndefined();
      });
    });
  });
});
