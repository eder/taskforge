import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitService } from '../src/git-service.js';
import { WorktreeManager, parseAgeSpec } from '../src/worktree-manager.js';

describe('parseAgeSpec', () => {
  it('parses supported units', () => {
    expect(parseAgeSpec('90s')).toBe(90_000);
    expect(parseAgeSpec('30m')).toBe(1_800_000);
    expect(parseAgeSpec('12h')).toBe(43_200_000);
    expect(parseAgeSpec('7d')).toBe(604_800_000);
    expect(parseAgeSpec('2w')).toBe(1_209_600_000);
  });

  it('rejects malformed input', () => {
    expect(() => parseAgeSpec('7')).toThrow(/Invalid age/);
    expect(() => parseAgeSpec('d7')).toThrow(/Invalid age/);
    expect(() => parseAgeSpec('')).toThrow(/Invalid age/);
  });
});

describe('WorktreeManager.pruneStale', () => {
  const repoRoot = path.resolve(__dirname, '../test-sandbox-prune-stale');
  let git: GitService;
  let head: string;

  beforeEach(async () => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.mkdirSync(repoRoot, { recursive: true });
    git = new GitService(repoRoot);
    await git.exec(['init', '-b', 'main'], repoRoot);
    await git.exec(['config', 'user.name', 'Prune Test'], repoRoot);
    await git.exec(['config', 'user.email', 'prune@taskforge.dev'], repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# prune\n');
    head = await git.stageAndCommit('Initial commit', repoRoot);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const DAY = 86_400_000;

  it('removes stale worktrees, leftover dirs and temp branches; keeps run/delivery branches', async () => {
    // Simulate a crashed earlier session: worktree created by a manager that is now gone.
    const crashed = new WorktreeManager(repoRoot);
    const wt = await crashed.createWorktree('TASK-01', 'ASGN-1', head);
    await git.createBranch('taskforge/run-123', head);
    await git.createBranch('taskforge/commitment-intelligence', head);
    await git.createBranch('taskforge/TASK-99/ASGN-9', head); // dangling temp branch
    const leftover = path.join(repoRoot, '.taskforge/worktrees/TASK-02/ASGN-2');
    fs.mkdirSync(leftover, { recursive: true });

    const janitor = new WorktreeManager(repoRoot);
    const report = await janitor.pruneStale({
      olderThanMs: 7 * DAY,
      now: Date.now() + 8 * DAY, // everything is 8 days old
    });

    expect(report.worktrees).toContain(wt.path);
    expect(report.directories).toContain(leftover);
    expect(report.branches).toEqual(
      expect.arrayContaining(['taskforge/TASK-01/ASGN-1', 'taskforge/TASK-99/ASGN-9']),
    );
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(fs.existsSync(leftover)).toBe(false);

    expect(await git.branchExists('taskforge/run-123')).toBe(true);
    expect(await git.branchExists('taskforge/commitment-intelligence')).toBe(true);
    expect(await git.branchExists('taskforge/TASK-99/ASGN-9')).toBe(false);
  });

  it('keeps anything newer than the threshold', async () => {
    const crashed = new WorktreeManager(repoRoot);
    const wt = await crashed.createWorktree('TASK-01', 'ASGN-1', head);

    const report = await new WorktreeManager(repoRoot).pruneStale({ olderThanMs: 7 * DAY });

    expect(report.worktrees).toEqual([]);
    expect(report.branches).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('never removes worktrees owned by the current process', async () => {
    const manager = new WorktreeManager(repoRoot);
    const wt = await manager.createWorktree('TASK-01', 'ASGN-1', head);

    const report = await manager.pruneStale({ olderThanMs: 0, now: Date.now() + DAY });

    expect(report.worktrees).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('dry run reports without removing', async () => {
    const crashed = new WorktreeManager(repoRoot);
    const wt = await crashed.createWorktree('TASK-01', 'ASGN-1', head);

    const report = await new WorktreeManager(repoRoot).pruneStale({
      olderThanMs: 7 * DAY,
      now: Date.now() + 8 * DAY,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.worktrees).toContain(wt.path);
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(await git.branchExists('taskforge/TASK-01/ASGN-1')).toBe(true);
  });
});

describe('WorktreeManager managed-worktree boundary', () => {
  const repoRoot = path.resolve(__dirname, '../test-sandbox-managed-boundary');
  const userWorktree = path.resolve(__dirname, '../test-sandbox-managed-boundary-user-wt');

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(userWorktree, { recursive: true, force: true });
  });

  it('lists and cleans only TaskForge worktrees, never ones the user created', async () => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.mkdirSync(repoRoot, { recursive: true });
    const git = new GitService(repoRoot);
    await git.exec(['init', '-b', 'main'], repoRoot);
    await git.exec(['config', 'user.name', 'Boundary Test'], repoRoot);
    await git.exec(['config', 'user.email', 'boundary@taskforge.dev'], repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# boundary\n');
    const head = await git.stageAndCommit('Initial commit', repoRoot);

    // A linked worktree the user made for their own work.
    await git.exec(['worktree', 'add', '-b', 'my-feature', userWorktree, head], repoRoot);
    const manager = new WorktreeManager(repoRoot);
    const managed = await manager.createWorktree('TASK-01', 'ASGN-1', head);

    expect(await manager.listManagedWorktrees()).toEqual([managed.path]);

    await manager.cleanOrphanedWorktreesAndBranches();

    expect(fs.existsSync(userWorktree)).toBe(true);
    expect(fs.existsSync(managed.path)).toBe(false);
  });
});

describe('WorktreeManager dependency links', () => {
  const repoRoot = path.resolve(__dirname, '../test-sandbox-links');
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  it('symlinks node_modules into worktrees without ever letting git stage the link', async () => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoRoot, 'node_modules/dep'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'packages/a/node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
    const git = new GitService(repoRoot);
    await git.exec(['init', '-b', 'main'], repoRoot);
    await git.exec(['config', 'user.name', 'Link Test'], repoRoot);
    await git.exec(['config', 'user.email', 'link@taskforge.dev'], repoRoot);
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'node_modules/\n'); // dir-only pattern: does not match a symlink
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# links\n');
    fs.writeFileSync(path.join(repoRoot, 'packages/a/index.js'), 'x\n');
    const head = await git.stageAndCommit('Initial commit', repoRoot);

    const manager = new WorktreeManager(repoRoot, '.taskforge/worktrees', [
      'node_modules',
      'packages/*/node_modules',
    ]);
    const wt = await manager.createWorktree('TASK-01', 'ASGN-1', head);

    expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(wt.path, 'node_modules/dep/index.js'))).toBe(true);
    expect(fs.lstatSync(path.join(wt.path, 'packages/a/node_modules')).isSymbolicLink()).toBe(true);

    // An agent making a change and the scheduler committing with `git add -A`:
    fs.writeFileSync(path.join(wt.path, 'feature.js'), 'f\n');
    const wtGit = new GitService(wt.path);
    await wtGit.stageAndCommit('feat: change', wt.path);
    const files = await wtGit.exec(['ls-tree', '-r', '--name-only', 'HEAD'], wt.path);
    expect(files).toContain('feature.js');
    expect(files).not.toContain('node_modules');
  });

  it('does nothing when no links are configured', async () => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoRoot, 'node_modules'), { recursive: true });
    const git = new GitService(repoRoot);
    await git.exec(['init', '-b', 'main'], repoRoot);
    await git.exec(['config', 'user.name', 'Link Test'], repoRoot);
    await git.exec(['config', 'user.email', 'link@taskforge.dev'], repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# links\n');
    const head = await git.stageAndCommit('Initial commit', repoRoot);

    const wt = await new WorktreeManager(repoRoot).createWorktree('TASK-01', 'ASGN-1', head);
    expect(fs.existsSync(path.join(wt.path, 'node_modules'))).toBe(false);
  });
});
