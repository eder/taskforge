import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from '../src/worktree-manager.js';

describe('WorktreeManager pnpm v12 node_modules compatibility', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('creates node_modules as a real directory with per-entry symlinks and skips pnpm runtime state dirs', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pnpm-wt-'));
    tempDirs.push(repo);

    execSync('git init -b main', { cwd: repo, stdio: 'ignore' });
    execSync('git config user.email "test@taskforge.local"', { cwd: repo, stdio: 'ignore' });
    execSync('git config user.name "TaskForge Test"', { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'index.ts'), 'export const ok = true;\n', 'utf8');
    execSync('git add -A && git commit -m "chore: init"', { cwd: repo, stdio: 'ignore' });

    // Simulate pnpm v12 root node_modules layout
    const nm = path.join(repo, 'node_modules');
    fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
    fs.mkdirSync(path.join(nm, '.pnpm'), { recursive: true });
    fs.mkdirSync(path.join(nm, '.pnpm-task-run-state-v1'), { recursive: true });
    fs.writeFileSync(path.join(nm, '.pnpm-workspace-state-v1.json'), '{"v":1}', 'utf8');
    fs.writeFileSync(path.join(nm, '.modules.yaml'), 'layoutVersion: 5\n', 'utf8');
    fs.mkdirSync(path.join(nm, 'vitest'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'vitest', 'package.json'), '{"name":"vitest"}', 'utf8');

    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    const manager = new WorktreeManager(repo, '.taskforge/worktrees', ['node_modules']);
    const wt = await manager.createWorktree('TASK-1', 'asgn-1', head);

    const wtNm = path.join(wt.path, 'node_modules');
    const wtNmStat = fs.lstatSync(wtNm);
    expect(wtNmStat.isDirectory()).toBe(true);
    expect(wtNmStat.isSymbolicLink()).toBe(false);

    // Dependencies & .pnpm are symlinked inside the real directory
    expect(fs.lstatSync(path.join(wtNm, 'vitest')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(wtNm, 'vitest', 'package.json'))).toBe(true);
    expect(fs.lstatSync(path.join(wtNm, '.pnpm')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(wtNm, '.bin')).isSymbolicLink()).toBe(true);

    // pnpm v12 task/workspace runtime state files are NOT shared across worktrees
    expect(fs.existsSync(path.join(wtNm, '.pnpm-task-run-state-v1'))).toBe(false);
    expect(fs.existsSync(path.join(wtNm, '.pnpm-workspace-state-v1.json'))).toBe(false);

    // Git working tree remains completely clean
    const porcelain = execSync('git status --porcelain', { cwd: wt.path, encoding: 'utf8' }).trim();
    expect(porcelain).toBe('');

    // Removing the worktree leaves main checkout's node_modules intact
    await manager.removeWorktree('TASK-1', 'asgn-1', true, true);
    expect(fs.existsSync(path.join(nm, 'vitest', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(nm, '.pnpm-task-run-state-v1'))).toBe(true);
  });
});
