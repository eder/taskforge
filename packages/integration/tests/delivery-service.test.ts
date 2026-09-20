import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskForgeDatabase, RunRepository, EventRepository } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { DeliveryService } from '../src/delivery-service.js';

describe('DeliveryService', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-delivery');
  let gitService: GitService;
  let baseCommit: string;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService.exec(['init', '-b', 'main'], testRepoRoot);
    await gitService.exec(['config', 'user.name', 'TaskForge Delivery Bot'], testRepoRoot);
    await gitService.exec(['config', 'user.email', 'delivery@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'shared.txt'), 'line one\nline two\nline three\n');
    baseCommit = await gitService.stageAndCommit('Initial commit', testRepoRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
  });

  function makeService(): { db: TaskForgeDatabase; runRepo: RunRepository; service: DeliveryService } {
    const db = new TaskForgeDatabase(':memory:');
    const runRepo = new RunRepository(db);
    const eventRepo = new EventRepository(db);
    const service = new DeliveryService(testRepoRoot, gitService, runRepo, eventRepo);
    return { db, runRepo, service };
  }

  async function createIntegrationBranch(runId: string, fileName: string, content: string) {
    const branch = `taskforge/${runId}`;
    await gitService.createBranch(branch, baseCommit);
    await gitService.checkout(branch, testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, fileName), content);
    await gitService.stageAndCommit(`feat: ${fileName}`, testRepoRoot);
    await gitService.checkout('main', testRepoRoot);
    return branch;
  }

  it('applies a ready run cleanly and reports the merge commit', async () => {
    const { db, runRepo, service } = makeService();
    const runId = 'run-apply-happy';
    runRepo.create(runId);
    const branch = await createIntegrationBranch(runId, 'feature.txt', 'new feature\n');
    service.markReady(runId, branch, 'main', baseCommit);

    const result = await service.apply(runId);

    expect(result.alreadyApplied).toBe(false);
    expect(fs.existsSync(path.join(testRepoRoot, 'feature.txt'))).toBe(true);
    expect(service.getDelivery(runId)?.status).toBe('applied');
    expect(service.getDelivery(runId)?.appliedCommit).toBe(result.commit);

    db.close();
  });

  it('is idempotent when applying an already-applied run again', async () => {
    const { db, runRepo, service } = makeService();
    const runId = 'run-apply-twice';
    runRepo.create(runId);
    const branch = await createIntegrationBranch(runId, 'feature2.txt', 'new feature 2\n');
    service.markReady(runId, branch, 'main', baseCommit);

    const first = await service.apply(runId);
    const second = await service.apply(runId);

    expect(first.alreadyApplied).toBe(false);
    expect(second.alreadyApplied).toBe(true);

    db.close();
  });

  it('refuses to apply when the working tree is dirty', async () => {
    const { db, runRepo, service } = makeService();
    const runId = 'run-apply-dirty';
    runRepo.create(runId);
    const branch = await createIntegrationBranch(runId, 'feature3.txt', 'new feature 3\n');
    service.markReady(runId, branch, 'main', baseCommit);

    fs.writeFileSync(path.join(testRepoRoot, 'uncommitted.txt'), 'oops\n');

    await expect(service.apply(runId)).rejects.toThrow(/not clean/);

    db.close();
  });

  it('detects a conflicting merge, aborts cleanly, and never touches the target branch', async () => {
    const { db, runRepo, service } = makeService();
    const runId = 'run-apply-conflict';
    runRepo.create(runId);
    const branch = await createIntegrationBranch(
      runId,
      'shared.txt',
      'line one\nCHANGED BY AGENT\nline three\n',
    );

    // main diverges with a conflicting edit to the very same line
    fs.writeFileSync(
      path.join(testRepoRoot, 'shared.txt'),
      'line one\nCHANGED BY HUMAN\nline three\n',
    );
    const mainHeadBeforeApply = await gitService.stageAndCommit(
      'chore: conflicting human edit',
      testRepoRoot,
    );

    service.markReady(runId, branch, 'main', baseCommit);

    await expect(service.apply(runId)).rejects.toMatchObject({
      context: { conflictingFiles: ['shared.txt'] },
    });

    // the target branch must be left exactly as it was, with no merge in progress
    const status = await gitService.getStatus(testRepoRoot);
    expect(status.isClean).toBe(true);
    expect(status.headCommit).toBe(mainHeadBeforeApply);
    expect(service.getDelivery(runId)?.status).toBe('ready_to_apply');

    db.close();
  });
});
