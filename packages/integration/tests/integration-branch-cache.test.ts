import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { IntegrationService } from '../src/integration-service.js';

describe('IntegrationService branch init is per run', () => {
  let root: string;
  let git: GitService;
  let base: string;
  let worktrees: WorktreeManager;
  let service: IntegrationService;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-integ-'));
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'Integ'], root);
    await git.exec(['config', 'user.email', 'i@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# integ\n');
    base = await git.stageAndCommit('init', root);
    worktrees = new WorktreeManager(root);
    service = new IntegrationService(root, git, worktrees, undefined as never);
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives each run its own branch even when one service instance serves both', async () => {
    const a = await service.initIntegrationBranch('run-1', base);
    const b = await service.initIntegrationBranch('run-2', base);
    expect(a).toBe('taskforge/run-1');
    expect(b).toBe('taskforge/run-2');
    expect(await git.branchExists('taskforge/run-1')).toBe(true);
    expect(await git.branchExists('taskforge/run-2')).toBe(true);
  });

  it('recreates the branch if it was deleted after being initialised', async () => {
    await service.initIntegrationBranch('run-1', base);
    await git.exec(['branch', '-D', 'taskforge/run-1'], root);
    expect(await git.branchExists('taskforge/run-1')).toBe(false);

    await service.initIntegrationBranch('run-1', base);
    expect(await git.branchExists('taskforge/run-1')).toBe(true);
  });
});
