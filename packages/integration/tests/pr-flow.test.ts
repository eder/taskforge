import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskForgeDatabase, RunRepository, VerificationRepository, TaskRepository } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { GitHubWorkflowService } from '../src/github-workflow.js';

describe('pull request flow', () => {
  let tmp: string;
  let repo: string;
  let remote: string;
  let fakeBin: string;
  let originalPath: string | undefined;
  let git: GitService;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pr-flow-'));
    repo = path.join(tmp, 'repo');
    remote = path.join(tmp, 'remote.git');
    fakeBin = path.join(tmp, 'bin');
    fs.mkdirSync(repo);
    fs.mkdirSync(fakeBin);
    git = new GitService(repo);
    await git.exec(['init', '-b', 'main'], repo);
    await git.exec(['config', 'user.name', 'PR Test'], repo);
    await git.exec(['config', 'user.email', 'pr@taskforge.dev'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await git.stageAndCommit('init', repo);
    await git.exec(['init', '--bare', '-b', 'main', remote], tmp);
    await git.exec(['remote', 'add', 'origin', remote], repo);
    await git.createBranch('taskforge/my-change', 'main');

    // Fake `gh`: records its arguments and prints a PR URL.
    fs.writeFileSync(
      path.join(fakeBin, 'gh'),
      `#!/bin/sh\necho "$@" > "${tmp}/gh-args.txt"\necho https://github.com/o/r/pull/7\n`,
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function service() {
    const db = new TaskForgeDatabase(':memory:');
    new RunRepository(db).create('run-pr');
    return { db, service: new GitHubWorkflowService(db, repo) };
  }

  it('pushes the head branch to the remote before opening the PR', async () => {
    const { db, service: gh } = service();
    const result = await gh.createPullRequest({
      runId: 'run-pr',
      targetBranch: 'main',
      headBranch: 'taskforge/my-change',
      repoRoot: repo,
    });

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe('https://github.com/o/r/pull/7');
    const remoteBranches = await git.exec(['branch', '--list'], remote);
    expect(remoteBranches).toContain('taskforge/my-change');
    expect(fs.readFileSync(path.join(tmp, 'gh-args.txt'), 'utf8')).toContain('--head taskforge/my-change');
    db.close();
  });

  it('reports a clear error and does not call gh when there is no remote', async () => {
    await git.exec(['remote', 'remove', 'origin'], repo);
    const { db, service: gh } = service();
    const result = await gh.createPullRequest({
      runId: 'run-pr',
      headBranch: 'taskforge/my-change',
      repoRoot: repo,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('no git remote');
    expect(fs.existsSync(path.join(tmp, 'gh-args.txt'))).toBe(false);
    db.close();
  });

  it('does not claim tests/lint/typecheck passed when no verification was recorded', async () => {
    const { db, service: gh } = service();
    const summary = gh.generatePullRequestSummary('run-pr');
    expect(summary).not.toMatch(/Automated Tests:\*\* PASS/);
    expect(summary).toContain('No automated verification results were recorded');
    db.close();
  });

  it('lists the actual verification checks, including failures, per task', async () => {
    const { db, service: gh } = service();
    new TaskRepository(db).create({
      id: 'TASK-01',
      runId: 'run-pr',
      title: 't',
      description: 'd',
      type: 'implementation',
      status: 'integrated',
    });
    new VerificationRepository(db).save('TASK-01', 'run-pr', {
      passed: false,
      failureReason: 'lint failed',
      checks: [
        { name: 'tests', command: 'npm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1, success: true },
        { name: 'lint', command: 'npm run lint', exitCode: 1, stdout: '', stderr: '', durationMs: 1, success: false },
      ],
    });

    const summary = gh.generatePullRequestSummary('run-pr');
    expect(summary).toContain('✅ `npm test`');
    expect(summary).toContain('❌ `npm run lint`');
    db.close();
  });
});
