import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git-service.js';
import { RepositoryAnalyzer } from '../src/repository-analyzer.js';
import { buildRepositoryMap } from '../src/repository-map.js';

describe('buildRepositoryMap', () => {
  it('lists top-level directories with counts and the dominant file types', () => {
    const map = buildRepositoryMap([
      'README.md',
      'src/a.ts',
      'src/b.ts',
      'src/c.json',
      'docs/x.md',
    ]);
    expect(map).toContain('(repository root) — 1 files');
    expect(map).toContain('src/ — 3 files (ts 2, json 1)');
    expect(map).toContain('docs/ — 1 files (md 1)');
  });

  it('opens the largest directories so a monorepo shows its packages, not just "packages/"', () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => `packages/storage/src/f${i}.ts`),
      ...Array.from({ length: 20 }, (_, i) => `packages/http/src/f${i}.ts`),
      'packages/http/package.json',
      'docs/a.md',
    ];
    const map = buildRepositoryMap(files);
    expect(map.some((l) => l.startsWith('packages/storage/'))).toBe(true);
    expect(map.some((l) => l.startsWith('packages/http/'))).toBe(true);
    expect(map.some((l) => l.startsWith('packages/ '))).toBe(false);
  });

  it('keeps a line for the files that sit directly in a directory that was opened', () => {
    const files = [
      ...Array.from({ length: 5 }, (_, i) => `tests/unit${i}.test.ts`),
      ...Array.from({ length: 5 }, (_, i) => `tests/setup/s${i}.ts`),
      'src/a.ts',
    ];
    const map = buildRepositoryMap(files);
    expect(map).toContain('tests/ — 5 files directly in it');
    expect(map).toContain('tests/setup/ — 5 files (ts 5)');
  });

  it('stays within the line budget however large the repository is', () => {
    const files = Array.from({ length: 3000 }, (_, i) => `d${i % 200}/s${i % 37}/f${i}.ts`);
    expect(buildRepositoryMap(files).length).toBeLessThanOrEqual(42);
  });

  it('handles an empty list and files only at the root', () => {
    expect(buildRepositoryMap([])).toEqual([]);
    expect(buildRepositoryMap(['a.ts', 'b.ts'])).toEqual(['(repository root) — 2 files']);
  });
});

describe('RepositoryAnalyzer repositoryMap', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-map-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('maps tracked files only and leaves it out of a folder that is not a repository', async () => {
    expect((await new RepositoryAnalyzer(dir).analyze()).repositoryMap).toBeUndefined();

    const git = new GitService(dir);
    await git.exec(['init', '-b', 'main']);
    await git.exec(['config', 'user.name', 'T']);
    await git.exec(['config', 'user.email', 't@taskforge.dev']);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x');
    await git.exec(['add', 'src/a.ts']);
    await git.exec(['commit', '-m', 'init']);

    const map = (await new RepositoryAnalyzer(dir).analyze()).repositoryMap;
    expect(map).toEqual(['src/ — 1 files (ts 1)']);
  });
});
