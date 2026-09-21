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

describe('/inspect: completed-run Run -> Task -> Assignment review', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-inspect-run-test-'));
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

  it('shows tasks, assignments, and intent-normalization events for a read-only run', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    await shell.handleInput(
      'Evaluate whether this repository should adopt the OpenAI Agents SDK. Do not modify any files.',
    );
    await shell.handleInput('yes --fake');

    const inspection = stripAnsi(await shell.handleInput('/inspect'));

    expect(inspection).toContain('RUN');
    expect(inspection).toMatch(/T\d+/); // at least one task id
    expect(inspection).toContain('Intent normalized');
    expect(inspection).toContain('investigation');
  });

  it('shows assignments with agent/role/status for an implementation run', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    await shell.handleInput('create application health endpoint');
    await shell.handleInput('yes --fake');

    const inspection = stripAnsi(await shell.handleInput('/inspect'));

    expect(inspection).toContain('RUN');
    expect(inspection).toContain('Assignments');
    expect(inspection).toContain('Fake Agent');
  });

  it('reports a clear message for an unknown run id', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    const reply = await shell.handleInput('/inspect run-does-not-exist');
    expect(reply).toContain('No run found');
  });

  it('reports a clear message when there are no runs at all', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    const reply = await shell.handleInput('/inspect');
    expect(reply).toContain('No runs recorded yet');
  });
});
