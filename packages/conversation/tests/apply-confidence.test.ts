import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository, VerificationRepository } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { OperatorIntentParser } from '@taskforge/operator';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('apply confidence and undo in the REPL', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let git: GitService;
  let shell: InteractiveShell | undefined;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-apply-test-'));
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    git = new GitService(dir);
    await git.exec(['init', '-b', 'main'], dir);
    await git.exec(['config', 'user.name', 'T'], dir);
    await git.exec(['config', 'user.email', 't@taskforge.dev'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'test.db*\n');
    base = await git.stageAndCommit('Initial commit', dir);
  });
  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function readyRun(runId: string, verified: boolean) {
    new GoalRepository(db).create({ id: `g-${runId}`, description: 'Add the feature file', repository: dir });
    new RunRepository(db).create(runId, `g-${runId}`, {});
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(`T-${runId}`, runId, 'Add feature', 'x', 'implementation', 'integrated', new Date().toISOString(), new Date().toISOString());
    if (verified) {
      new VerificationRepository(db).save(`T-${runId}`, runId, {
        passed: true,
        checks: [{ name: 'test', command: 'npm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1, success: true }],
      });
    }
    const branch = `taskforge/${runId}`;
    await git.createBranch(branch, base);
    await git.checkout(branch, dir);
    fs.writeFileSync(path.join(dir, `${runId}.txt`), 'feature\n');
    await git.stageAndCommit('feat: file', dir);
    await git.checkout('main', dir);
    (shell as any).deliveryService.markReady(runId, branch, 'main', base);
  }

  it('does not apply an unverified run on a bare /apply: shows how it was (not) checked and asks for --yes', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    await readyRun('run-1790000000000001', false);

    const reply = plain(await shell.handleInput('/apply run-1790000000000001'));

    expect(reply).toContain('Before applying run-1790000000000001');
    expect(reply).toContain('What it does: Add the feature file');
    expect(reply).toContain('no automated checks ran');
    expect(reply).toContain('--yes');
    expect(fs.existsSync(path.join(dir, 'run-1790000000000001.txt'))).toBe(false);
    expect((shell as any).deliveryService.getDelivery('run-1790000000000001').status).toBe('ready_to_apply');
  });

  it('applies with --yes, and applies a verified run without asking', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    await readyRun('run-1790000000000002', false);
    await readyRun('run-1790000000000003', true);

    expect(plain(await shell.handleInput('/apply run-1790000000000002 --yes'))).toContain('Applied successfully');
    expect(plain(await shell.handleInput('/apply run-1790000000000003'))).toContain('Applied successfully');
  });

  it('/diff says how the change was checked', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    await readyRun('run-1790000000000004', true);
    const reply = plain(await shell.handleInput('/diff run-1790000000000004'));
    expect(reply).toContain('How it was checked');
    expect(reply).toContain('test passed');
  });

  it('/undo reverses the last applied run and says how to bring it back', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    await readyRun('run-1790000000000005', true);
    await shell.handleInput('/apply run-1790000000000005');
    expect(fs.existsSync(path.join(dir, 'run-1790000000000005.txt'))).toBe(true);

    const reply = plain(await shell.handleInput('/undo'));

    expect(reply).toContain('Undid run-1790000000000005');
    expect(reply).toContain('git revert');
    expect(fs.existsSync(path.join(dir, 'run-1790000000000005.txt'))).toBe(false);
    expect(plain(await shell.handleInput('/undo'))).toContain('No applied run to undo');
  });

  it('parses /apply flags and /undo', () => {
    expect(OperatorIntentParser.parse('/apply 2 --yes')).toEqual({ type: 'apply_run', runId: '2', confirmed: true });
    expect(OperatorIntentParser.parse('/apply')).toEqual({ type: 'apply_run', runId: undefined, confirmed: false });
    expect(OperatorIntentParser.parse('/undo last')).toEqual({ type: 'undo_run', runId: 'last' });
  });
});
