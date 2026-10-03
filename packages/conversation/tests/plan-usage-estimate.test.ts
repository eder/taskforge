import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';
import { formatUsageEstimate } from '../src/shell-formatters.js';

describe('plan usage estimate', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-estimate-test-'));
    db = new TaskForgeDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('formats an approximate range with confidence and a severity color', () => {
    const line = formatUsageEstimate({
      minTokens: 40_000,
      expectedTokens: 120_000,
      maxTokens: 400_000,
      confidence: 'low',
      baselineAssignments: 3,
      breakdown: [],
      assumptions: [],
    });
    expect(line).toContain('Estimated usage');
    expect(line).toContain('120k');
    expect(line).toContain('40k');
    expect(line).toContain('400k');
    expect(line).toContain('confidence low');
  });

  it('shows the estimate before asking the user to approve a write plan', async () => {
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });

    const reply = await shell.handleInput(
      'implement password reset with token expiry and add regression tests',
    );

    expect(reply).toContain('Plan Proposal');
    expect(reply).toContain('Estimated usage');
    expect(reply.indexOf('Estimated usage')).toBeLessThan(reply.indexOf('Do you want me to execute'));
    // The estimate is not a ceiling: tell the person how staffing and the cap really work.
    expect(reply).toContain('Each task is staffed when it starts');
    expect(reply).toContain('stops starting new tasks at 1,000,000 tokens');
  });
});
