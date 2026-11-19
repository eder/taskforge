import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitService, WorktreeManager } from '@taskforge/workspace';

export interface GitSandbox {
  root: string;
  git: GitService;
  worktrees: WorktreeManager;
  baseCommit: string;
}

interface TemplateRepo {
  dir: string;
  baseCommit: string;
}

let cachedTemplate: TemplateRepo | undefined;

function getTemplateRepo(): TemplateRepo {
  if (cachedTemplate && fs.existsSync(cachedTemplate.dir)) {
    return cachedTemplate;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-git-template-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'TaskForge Bot');
  git('config', 'user.email', 'bot@taskforge.dev');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Sandbox\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial commit');
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  cachedTemplate = { dir, baseCommit };
  process.once('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors at process exit
    }
  });
  return cachedTemplate;
}

/**
 * Replaces `targetDir` with a fresh copy of the worker's cached template Git
 * repo (~1ms instead of 5 git subprocess spawns per test).
 */
export function cloneTemplateRepo(targetDir: string): GitSandbox {
  const template = getTemplateRepo();
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(template.dir, targetDir, { recursive: true });
  return {
    root: targetDir,
    git: new GitService(targetDir),
    worktrees: new WorktreeManager(targetDir, '.taskforge/worktrees'),
    baseCommit: template.baseCommit,
  };
}

/**
 * Provides an isolated real Git repository by cloning a worker-local template
 * with `fs.cpSync` (~1ms instead of 5 git subprocesses per test), safe for
 * `describe.concurrent` / `it.concurrent`.
 */
export async function withGitSandbox<T>(
  fn: (sandbox: GitSandbox) => Promise<T>,
  options: { prefix?: string; extraFiles?: Record<string, string> } = {},
): Promise<T> {
  const template = getTemplateRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'tf-sched-'));
  fs.cpSync(template.dir, root, { recursive: true });

  const git = new GitService(root);
  let baseCommit = template.baseCommit;
  if (options.extraFiles && Object.keys(options.extraFiles).length > 0) {
    for (const [rel, content] of Object.entries(options.extraFiles)) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
    baseCommit = await git.stageAndCommit('Initial fixtures', root);
  }

  const worktrees = new WorktreeManager(root, '.taskforge/worktrees');
  try {
    return await fn({ root, git, worktrees, baseCommit });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
