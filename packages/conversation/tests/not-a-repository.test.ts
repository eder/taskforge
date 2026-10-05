import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * TaskForge opened in a folder that holds projects (not a project itself) used to run
 * `git init` there and `git add -A` over everything in it. It must refuse, say why, point
 * at the real projects, and leave the folder exactly as it found it.
 */
describe('TaskForge opened in a folder that is not a git repository', () => {
  let dir: string;
  let shell: InteractiveShell | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-notrepo-'));
    // Two real projects inside it, plus a plain folder, like a ~/projects directory.
    for (const name of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(dir, name));
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path.join(dir, name), stdio: 'ignore' });
    }
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'alpha', '.env'), 'SECRET=1\n');
  });
  afterEach(() => {
    shell?.close();
    shell = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says so in the banner, and does not leave a .taskforge state directory behind', async () => {
    shell = new InteractiveShell({ repoRoot: dir });
    const banner = plain(await shell.renderBanner());
    expect(banner).toContain('not a git repository');
    expect(fs.existsSync(path.join(dir, '.taskforge'))).toBe(false);
  });

  it('plans, but refuses to execute: it names the projects here and creates nothing', async () => {
    shell = new InteractiveShell({ repoRoot: dir });
    const proposal = plain(await shell.handleInput('implement password reset with token expiry and add tests'));
    expect(proposal).toContain('Plan Proposal');

    const reply = plain(await shell.handleInput('yes'));

    expect(reply).toContain('is not a git repository');
    expect(reply).toContain('it will not create or commit one for you');
    expect(reply).toContain('Projects in this folder: alpha, beta');
    expect(reply).toContain('cd alpha && tf');
    expect(reply).not.toContain('notes');
    // Nothing was created or committed in the folder.
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.taskforge'))).toBe(false);
  });

  it('a read-only question starts through the same approval path, so it gets the same answer and no repository', async () => {
    shell = new InteractiveShell({ repoRoot: dir });
    await shell.handleInput('explain what this folder contains');
    // With an agent available a read-only goal approves itself by calling /approve.
    const reply = plain(await shell.handleInput('/approve'));
    expect(reply).toContain('is not a git repository');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
  });
});
