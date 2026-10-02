import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner, isDocumentationOnlyChange } from '../src/verification-runner.js';

describe('isDocumentationOnlyChange', () => {
  it('accepts prose files and well-known project docs', () => {
    expect(isDocumentationOnlyChange(['docs/project-state.md'])).toBe(true);
    expect(isDocumentationOnlyChange(['README.md', 'docs/guide.rst', 'NOTES.txt'])).toBe(true);
    expect(isDocumentationOnlyChange(['LICENSE', 'CHANGELOG'])).toBe(true);
  });

  it('rejects code, config, scripts and data, even under docs/', () => {
    expect(isDocumentationOnlyChange(['src/app.py'])).toBe(false);
    expect(isDocumentationOnlyChange(['docs/conf.py'])).toBe(false);
    expect(isDocumentationOnlyChange(['docs/openapi.json'])).toBe(false);
    expect(isDocumentationOnlyChange(['README.md', 'package.json'])).toBe(false);
    expect(isDocumentationOnlyChange(['.github/workflows/ci.yml'])).toBe(false);
  });

  it('an empty change is not a documentation change', () => {
    expect(isDocumentationOnlyChange([])).toBe(false);
  });
});

describe('VerificationRunner with no discoverable verification', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-docs-only-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const verify = (options: Partial<Parameters<VerificationRunner['verify']>[0]> = {}) =>
    new VerificationRunner().verify({
      taskId: 'T',
      runId: 'R',
      worktreePath: dir, // no package.json: nothing to discover
      config: getDefaultConfig(),
      taskType: 'implementation',
      ...options,
    });

  it('still fails closed for a code change', async () => {
    const result = await verify();
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('No verification checks were executed');
  });

  it('passes a documentation-only change that has nothing to verify', async () => {
    const result = await verify({ documentationOnlyChange: true });
    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([]);
  });

  it('still runs and enforces explicit commands for a documentation-only change', async () => {
    const failing = await verify({ documentationOnlyChange: true, explicitCommands: ['false'] });
    expect(failing.passed).toBe(false);
    const passing = await verify({ documentationOnlyChange: true, explicitCommands: ['true'] });
    expect(passing.passed).toBe(true);
    expect(passing.checks).toHaveLength(1);
  });
});
