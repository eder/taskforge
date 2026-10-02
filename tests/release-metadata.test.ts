import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { TASKFORGE_VERSION } from '@taskforge/shared';

const repoRoot = path.resolve(__dirname, '..');

describe('release metadata', () => {
  it('keeps every workspace package publishable and in lockstep', () => {
    const output = execFileSync('node', ['scripts/verify-release.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(output).toContain('Release verification passed');
  });

  it('exposes the root package version as TASKFORGE_VERSION', () => {
    const root = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(TASKFORGE_VERSION).toBe(root.version);
  });

  it('documents the current version in the changelog', () => {
    const changelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [Unreleased]');
    expect(changelog).toMatch(/## \[\d+\.\d+\.\d+/);
  });
});
