import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';
import { formatUsageEstimate } from '../src/shell-formatters.js';
import { summarizeGoal } from '../src/shell-helpers.js';
import { theme } from '../src/theme.js';

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

describe('shell formatting helpers (theme and summarizeGoal)', () => {
  it('shows an absolute reset time instead of a frozen relative quota reason', () => {
    const resetAt = new Date(Date.now() + 90 * 60 * 1000);
    const rendered = theme.agentPill(
      'agy',
      'Google Antigravity',
      false,
      'quota_exhausted',
      'resets in 32h30m34s',
      resetAt,
    );
    expect(rendered).toContain('quota exhausted');
    expect(rendered).toContain('resets at');
    expect(rendered).not.toContain('32h30m34s');
  });

  it('summarizes goals to one clean line without cutting words in half', () => {
    expect(summarizeGoal('Add a greeting helper')).toBe('Add a greeting helper');
    const prompt = '\n\nQuero que você faça uma AVALIAÇÃO TÉCNICA\n\nESTA TAREFA É EXCLUSIVAMENTE DE ANÁLISE.';
    expect(summarizeGoal(prompt)).toBe('Quero que você faça uma AVALIAÇÃO TÉCNICA …');
    const out = summarizeGoal('word '.repeat(80).trim(), 40);
    expect(out.endsWith(' …')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(42);
    expect(out).not.toMatch(/wor …$/);
    expect(summarizeGoal('a    b\t c')).toBe('a b c');
    expect(summarizeGoal('   \n  ')).toBe('');
  });
});
