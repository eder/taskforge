import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('/apply and /diff result UX', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-apply-diff-test-'));
    // In-memory DB: keeps the repo working tree clean so /apply can
    // actually succeed (an on-disk sqlite file inside the repo root would
    // make the tree permanently dirty and /apply would always refuse).
    db = new TaskForgeDatabase(':memory:');
  });

  afterEach(() => {
    for (const shell of shellsToClean) {
      shell.close();
    }
    shellsToClean.length = 0;
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('/diff shows a summary-first view: total files/insertions/deletions, then a per-file M/A/D list', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    await shell.handleInput('create application health endpoint');
    await shell.handleInput('yes --fake');

    const diff = stripAnsi(await shell.handleInput('/diff'));
    expect(diff).toContain('Run Diff');
    expect(diff).toMatch(/\d+ files? changed/);
    expect(diff).toMatch(/^\s*\+\d+\s+-\d+/m);
  });

  it('/apply reports the branch transition, changed files and the applied commit', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    await shell.handleInput('create application health endpoint');
    await shell.handleInput('yes --fake');

    const applied = stripAnsi(await shell.handleInput('/apply'));
    expect(applied).toContain('Applied successfully');
    expect(applied).toMatch(/[0-9a-f]{7} → [0-9a-f]{7}/);
    expect(applied).toContain('Commit');
  });
});
