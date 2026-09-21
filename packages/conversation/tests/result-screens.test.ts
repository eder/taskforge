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

describe('Result screens differentiate READ_ONLY_ANALYSIS from IMPLEMENTATION', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-result-screens-test-'));
    db = new TaskForgeDatabase(path.join(tmpDir, 'test.db'));
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

  it('a read-only analysis run never offers /apply, /diff or /pr and reports zero files changed', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    const goalReply = await shell.handleInput(
      'Evaluate whether this repository should adopt the OpenAI Agents SDK. Do not modify any files.',
    );
    expect(goalReply).toContain('Do you want me to execute?');

    const summary = stripAnsi(await shell.handleInput('yes --fake'));

    expect(summary).toContain('Analysis Summary');
    expect(summary).toContain('Read-only policy respected');
    expect(summary).toContain('Files changed: 0');
    expect(summary).not.toContain('READY TO APPLY');
    expect(summary).not.toContain('/apply');
    expect(summary).not.toContain('/pr');
  });

  it('a normal implementation run still offers /apply and shows the delivery block', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    const goalReply = await shell.handleInput('create application health endpoint');
    expect(goalReply).toContain('Do you want me to execute?');

    const summary = stripAnsi(await shell.handleInput('yes --fake'));

    expect(summary).toContain('Run Summary');
    expect(summary).toContain('READY TO APPLY');
    expect(summary).toContain('/apply');
    expect(summary).not.toContain('Analysis Summary');
  });
});
