import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner } from '@taskforge/verification';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { IntegrationService } from '../src/integration-service.js';

describe('the final check of a run uses the commands the project configured', () => {
  let root: string;
  let git: GitService;
  let worktrees: WorktreeManager;
  let base: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-final-'));
    git = new GitService(root);
    await git.exec(['init', '-b', 'main'], root);
    await git.exec(['config', 'user.name', 'Final'], root);
    await git.exec(['config', 'user.email', 'f@taskforge.dev'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# project\n');
    base = await git.stageAndCommit('init', root);
    // A Python project: nothing for TaskForge to discover on its own.
    await git.exec(['checkout', '-q', '-b', 'work'], root);
    fs.writeFileSync(path.join(root, 'app.py'), 'print(1)\n');
    await git.stageAndCommit('add app', root);
    await git.exec(['checkout', '-q', 'main'], root);
    worktrees = new WorktreeManager(root);
  });

  afterEach(async () => {
    await worktrees.prune().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function finalize(commands?: string[]) {
    const service = new IntegrationService(root, git, worktrees, new VerificationRunner());
    await service.initIntegrationBranch('run-1', base);
    await git.exec(['branch', '-f', 'taskforge/run-1', 'work'], root);
    const config = getDefaultConfig();
    config.verification.commands = commands ?? [];
    return service.finalizeRun('run-1', config, base);
  }

  it('passes when the configured command passes, although nothing could be discovered', async () => {
    const result = await finalize(['test -f app.py']);
    expect(result.verified).toBe(true);
  });

  it('fails when the configured command fails', async () => {
    await expect(finalize(['test -f missing.py'])).rejects.toThrow(/Final integration verification failed/);
  });

  it('still says what is missing when nothing is configured', async () => {
    await expect(finalize()).rejects.toThrow(/No verification checks were executed/);
  });
});
