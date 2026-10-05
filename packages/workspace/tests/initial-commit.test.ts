import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService, RepositoryNotReadyError } from '../src/git-service.js';

describe('ensureInitialCommit never creates a repository or commits the person’s files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-initcommit-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuses a folder that is not a repository, and leaves it untouched', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    await expect(new GitService(dir).ensureInitialCommit(dir)).rejects.toThrow(RepositoryNotReadyError);
    await expect(new GitService(dir).ensureInitialCommit(dir)).rejects.toThrow('never creates one for you');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
  });

  it('refuses a repository that has files but no commits, instead of committing them', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
    await expect(new GitService(dir).ensureInitialCommit(dir)).rejects.toThrow('will not commit them for you');
    // Still no commit and nothing staged.
    expect(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'ignore' })).toThrow();
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
  });

  it('gives a truly empty repository an empty first commit, so there is a base', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    const head = await new GitService(dir).ensureInitialCommit(dir);
    expect(head).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('returns the existing commit for a normal repository', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir, stdio: 'ignore' });
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(await new GitService(dir).ensureInitialCommit(dir)).toBe(expected);
  });
});
