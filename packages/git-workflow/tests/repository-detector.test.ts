import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitService } from '@taskforge/workspace';
import { detectWorkflowSuggestion } from '../src/repository-detector.js';

describe('detectWorkflowSuggestion', () => {
  const testRepoRoot = path.resolve(__dirname, '../test-sandbox-detector');
  let gitService: GitService;

  beforeEach(async () => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    gitService = new GitService(testRepoRoot);
    await gitService.exec(['init', '-b', 'main'], testRepoRoot);
    await gitService.exec(['config', 'user.name', 'TaskForge Bot'], testRepoRoot);
    await gitService.exec(['config', 'user.email', 'bot@taskforge.dev'], testRepoRoot);
    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Test\n');
    await gitService.stageAndCommit('Initial commit', testRepoRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
  });

  it('suggests nothing for a plain single-branch repository', async () => {
    const suggestion = await detectWorkflowSuggestion(gitService, testRepoRoot);
    expect(suggestion).toBeUndefined();
  });

  it('suggests gitflow when both main and develop exist', async () => {
    await gitService.createBranch('develop', await gitService.getHeadCommit(testRepoRoot));

    const suggestion = await detectWorkflowSuggestion(gitService, testRepoRoot);
    expect(suggestion?.suggested).toBe('gitflow');
  });
});
