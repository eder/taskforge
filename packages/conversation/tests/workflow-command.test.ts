import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@taskforge/shared';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { GitService } from '@taskforge/workspace';
import { OperatorIntentParser } from '@taskforge/operator';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('/workflow', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;
  const configFile = () => path.join(dir, '.taskforge', 'config.yaml');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-workflow-test-'));
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    const git = new GitService(dir);
    await git.exec(['init', '-b', 'main'], dir);
    await git.exec(['config', 'user.name', 'T'], dir);
    await git.exec(['config', 'user.email', 't@taskforge.dev'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
    await git.stageAndCommit('Initial commit', dir);
  });

  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // the shell may already have closed it
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses with and without an argument', () => {
    expect(OperatorIntentParser.parse('/workflow')).toEqual({
      type: 'set_workflow',
      workflow: undefined,
    });
    expect(OperatorIntentParser.parse('/workflow gitflow')).toEqual({
      type: 'set_workflow',
      workflow: 'gitflow',
    });
  });

  it('shows the current workflow without changing anything', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    expect(plain(await shell.handleInput('/workflow'))).toContain('Git workflow: trunk');
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('saves the choice, keeps the file comments and applies it to the session', async () => {
    fs.mkdirSync(path.dirname(configFile()));
    fs.writeFileSync(configFile(), '# my notes\nexecution:\n  profile: standard # keep\n');
    shell = new InteractiveShell({ repoRoot: dir, database: db });

    expect(plain(await shell.handleInput('/workflow gitflow'))).toContain('set to gitflow');

    const text = fs.readFileSync(configFile(), 'utf8');
    expect(text).toContain('# my notes');
    expect(text).toContain('# keep');
    expect(loadConfig(configFile()).git.workflow).toBe('gitflow');
    expect(plain(await shell!.handleInput('/workflow'))).toContain('Git workflow: gitflow');
  });

  it('rejects an unknown workflow and writes nothing', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    expect(plain(await shell.handleInput('/workflow svn'))).toContain('Unknown workflow "svn"');
    expect(fs.existsSync(configFile())).toBe(false);
  });
});
