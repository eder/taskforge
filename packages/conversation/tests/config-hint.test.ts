import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

describe('first-run notice about the optional .taskforge/config.yaml', () => {
  let dir: string;
  let db: TaskForgeDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hint-'));
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    delete process.env.TASKFORGE_NO_HINTS;
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by the shell
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startAndCapture(): Promise<string> {
    let text = '';
    const output = new Writable({
      write(chunk, _enc, cb) {
        text += chunk.toString();
        cb();
      },
    });
    const shell = new InteractiveShell({
      repoRoot: dir,
      database: new TaskForgeDatabase(path.join(dir, 'run.db')),
      input: Readable.from(['/exit\n']),
      output,
    });
    // Non-TTY output selects the line-based loop; the banner is written to stdout.
    const original = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await shell.start();
    } finally {
      process.stdout.write = original;
      shell.close();
    }
    return text + captured.join('');
  }

  it('explains the file once, says it is optional, and points to tf init', async () => {
    const first = await startAndCapture();
    expect(first).toContain('no .taskforge/config.yaml');
    expect(first).toContain('optional');
    expect(first).toContain('tf init');

    const second = await startAndCapture();
    expect(second).not.toContain('no .taskforge/config.yaml');
  });

  it('is silent when the project already has a config', async () => {
    fs.mkdirSync(path.join(dir, '.taskforge'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.taskforge/config.yaml'), 'execution:\n  maxParallelTasks: 2\n');
    expect(await startAndCapture()).not.toContain('no .taskforge/config.yaml');
  });

  it('can be disabled with TASKFORGE_NO_HINTS=1', async () => {
    process.env.TASKFORGE_NO_HINTS = '1';
    try {
      expect(await startAndCapture()).not.toContain('no .taskforge/config.yaml');
    } finally {
      delete process.env.TASKFORGE_NO_HINTS;
    }
  });
});
