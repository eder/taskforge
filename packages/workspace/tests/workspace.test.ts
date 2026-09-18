import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import { GitService } from '../src/git-service.js';
import { WorktreeManager } from '../src/worktree-manager.js';
import { RepositoryAnalyzer } from '../src/repository-analyzer.js';

describe('Workspace - Git and Worktrees', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const gitService = new GitService(repoRoot);
  const worktreeManager = new WorktreeManager(repoRoot, '.taskforge/test-worktrees');

  afterAll(async () => {
    await worktreeManager.removeWorktree('TASK-TEST', 'ASGN-1', true).catch(() => {});
    await worktreeManager.prune().catch(() => {});
  });

  it('checks git repository status and head commit', async () => {
    const isRepo = await gitService.isGitRepo();
    expect(isRepo).toBe(true);

    const status = await gitService.getStatus();
    expect(status.headCommit).toBeDefined();
    expect(status.headCommit.length).toBeGreaterThan(5);
  });

  it('analyzes repository profile', async () => {
    const analyzer = new RepositoryAnalyzer(repoRoot, gitService);
    const profile = await analyzer.analyze();

    expect(profile.languages).toContain('TypeScript');
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.testCommands.length).toBeGreaterThan(0);
  });

  it('creates and cleans up an isolated worktree', async () => {
    const head = await gitService.getHeadCommit();
    const wt = await worktreeManager.createWorktree('TASK-TEST', 'ASGN-1', head);

    expect(wt.taskId).toBe('TASK-TEST');
    expect(wt.assignmentId).toBe('ASGN-1');
    expect(wt.path).toContain('TASK-TEST');

    // Clean up
    await worktreeManager.removeWorktree('TASK-TEST', 'ASGN-1', true);
    expect(worktreeManager.getWorktree('TASK-TEST', 'ASGN-1')).toBeUndefined();
  });
});
