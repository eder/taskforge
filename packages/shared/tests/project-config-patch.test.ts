import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProjectConfigValue } from '../src/project-config-patch.js';

describe('setProjectConfigValue', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-patch-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the file when there is none and leaves no temporary file behind', () => {
    const { file } = setProjectConfigValue(dir, ['git', 'workflow'], 'gitflow');
    expect(fs.readFileSync(file, 'utf8')).toContain('workflow: gitflow');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['config.yaml']);
  });

  it('changes only the named key', () => {
    const file = path.join(dir, '.taskforge', 'config.yaml');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'git:\n  workflow: trunk # default\n  targetBranch: main\n');
    setProjectConfigValue(dir, ['git', 'workflow'], 'gitflow');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'git:\n  workflow: gitflow # default\n  targetBranch: main\n',
    );
  });
});
