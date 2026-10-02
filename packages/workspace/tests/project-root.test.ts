import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findProjectRoot } from '../src/project-root.js';

describe('findProjectRoot', () => {
  let base: string;
  const mk = (...parts: string[]) => {
    const dir = path.join(base, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    // realpath: macOS tmp dirs are symlinks, and comparisons must be exact
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-root-')));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('returns the git repository root from any sub-folder (the zaira/server case)', () => {
    const repo = mk('zaira');
    mk('zaira', '.git');
    const server = mk('zaira', 'server', 'adapters');
    expect(findProjectRoot(server, {})).toBe(repo);
    expect(findProjectRoot(repo, {})).toBe(repo);
  });

  it('is not fooled by a stray .taskforge left in a sub-folder', () => {
    const repo = mk('zaira');
    mk('zaira', '.git');
    mk('zaira', '.taskforge');
    const server = mk('zaira', 'server');
    mk('zaira', 'server', '.taskforge'); // created by running tf there before
    expect(findProjectRoot(server, {})).toBe(repo);
  });

  it('accepts a .git FILE (git worktrees and submodules)', () => {
    const wt = mk('wt');
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
    expect(findProjectRoot(mk('wt', 'src'), {})).toBe(wt);
  });

  it('uses the nearest repository when repositories are nested', () => {
    mk('outer', '.git');
    const inner = mk('outer', 'vendor', 'inner');
    mk('outer', 'vendor', 'inner', '.git');
    expect(findProjectRoot(mk('outer', 'vendor', 'inner', 'src'), {})).toBe(inner);
  });

  it('without git, falls back to the nearest ancestor that has a .taskforge', () => {
    const project = mk('proj');
    mk('proj', '.taskforge');
    expect(findProjectRoot(mk('proj', 'a', 'b'), {})).toBe(project);
  });

  it('never treats the home directory as a project because of the global ~/.taskforge', () => {
    const fakeHome = mk('home');
    mk('home', '.taskforge');
    const work = mk('home', 'scratch');
    const previous = process.env.HOME;
    process.env.HOME = fakeHome; // os.homedir() reads HOME on every call
    try {
      expect(findProjectRoot(work, {})).toBe(work);
    } finally {
      process.env.HOME = previous;
    }
  });

  it('with nothing recognizable, stays where it started', () => {
    const lonely = mk('lonely');
    expect(findProjectRoot(lonely, {})).toBe(lonely);
  });

  it('TASKFORGE_PROJECT_ROOT wins when it names an existing directory, and is ignored when it does not', () => {
    mk('repo', '.git');
    const elsewhere = mk('elsewhere');
    const inside = mk('repo', 'sub');
    expect(findProjectRoot(inside, { TASKFORGE_PROJECT_ROOT: elsewhere })).toBe(elsewhere);
    expect(findProjectRoot(inside, { TASKFORGE_PROJECT_ROOT: path.join(base, 'missing') })).toBe(
      path.join(base, 'repo'),
    );
  });
});
