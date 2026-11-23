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

describe('creating worktrees at the same time', () => {
  it('serializes git worktree add, so a competitive team never reads a half-written entry', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wt-race-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const manager = new WorktreeManager(root, '.taskforge/worktrees', []);

      for (let round = 0; round < 2; round++) {
        const created = await Promise.all(
          Array.from({ length: 10 }, (_, i) => manager.createWorktree(`T${round}`, `a${i}`, head)),
        );
        expect(created).toHaveLength(10);
        await Promise.all(created.map((w, i) => manager.removeWorktree(`T${round}`, `a${i}`, true, true)));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('links parent directories before redundant child paths so adding "testdata" after "testdata/a.pcm" exposes all files', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wt-links-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(root, '.gitignore'), 'testdata/\n');
      fs.mkdirSync(path.join(root, 'testdata'), { recursive: true });
      fs.writeFileSync(path.join(root, 'testdata', 'multiplex_seg1.pcm'), 'a');
      fs.writeFileSync(path.join(root, 'testdata', 'capital_irlanda.pcm'), 'b');
      git('add', '.gitignore');
      git('-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

      // Child listed BEFORE parent directory — previously created a real `testdata/` dir
      // and silently skipped linking `testdata`, leaving `capital_irlanda.pcm` missing.
      const manager = new WorktreeManager(root, '.taskforge/worktrees', [
        'testdata/multiplex_seg1.pcm',
        'testdata',
      ]);
      const wt = await manager.createWorktree('TASK-1', 'preflight', head, { detached: true });
      try {
        expect(fs.lstatSync(path.join(wt.path, 'testdata')).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(path.join(wt.path, 'testdata', 'capital_irlanda.pcm'), 'utf8')).toBe('b');
        expect(fs.readFileSync(path.join(wt.path, 'testdata', 'multiplex_seg1.pcm'), 'utf8')).toBe('a');
      } finally {
        await manager.removeWorktree('TASK-1', 'preflight', true, true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
