import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RunFailureLine } from '@taskforge/scheduler';
import { buildRunFocus } from '../src/run-focus.js';

const line = (over: Partial<RunFailureLine>): RunFailureLine => ({ taskId: 'T1', title: 'x', kind: 'blocked', ...over });

describe('what the REPL proposes when a run stops', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-focus-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '-m', 'i'], { cwd: repo });
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('offers to raise the cap when the run stopped at it, with the number it will use', () => {
    const { focus, lines, hint } = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [{ taskId: '', title: '', kind: 'budget', budget: { spent: 1_990_000, budget: 2_000_000 } }],
    });
    expect(focus.action).toEqual({ kind: 'raise_budget', budget: 4_000_000 });
    expect(lines.join('\n')).toContain('raise the cap to 4,000,000');
    expect(hint).toContain('Enter');
  });

  it('proposes the repair itself, in words, with no command for the person to type', () => {
    fs.writeFileSync(path.join(repo, '.env'), 'LLM_API_KEY=x\n');
    const { focus, lines } = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ failureClass: 'environment', evidence: 'RuntimeError: no LLM api_key configured' })],
    });
    expect(focus.action).toEqual({ kind: 'fix' });
    const text = lines.join('\n');
    expect(text).toContain('.env');
    expect(text).toContain('Then continue the run');
    expect(text).not.toMatch(/\btf (fix|resume)\b/);
  });

  it('asks how to start a service it cannot find, instead of leaving a to-do list', () => {
    const { focus, lines } = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ failureClass: 'environment', evidence: "OSError: [Errno 61] Connect call failed ('127.0.0.1', 5432)" })],
    });
    expect(focus.question).toEqual({ kind: 'start_command', port: 5432 });
    expect(lines.join('\n')).toContain('port 5432');
    expect(lines.join('\n')).toContain('type the command that starts it');
  });

  it('asks which command verifies the project when the check command does not work', () => {
    const { focus } = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ failureClass: 'verification_configuration', evidence: 'sh: pytest: command not found' })],
    });
    expect(focus.question).toEqual({ kind: 'check_command' });
  });

  it('proposes the check command it can read from the kept work, and saves it on Enter', () => {
    execFileSync('git', ['checkout', '-q', '-b', 'kept'], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'requirements.txt'), 'fastapi\n');
    fs.writeFileSync(path.join(repo, 'tests', 'test_api.py'), 'def test_x():\n    pass\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '-m', 'work'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });

    const { focus, lines, hint } = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ failureClass: 'verification_configuration', keptBranch: 'kept' })],
    });
    expect(focus.action.kind).toBe('save_check_command');
    expect(focus.action).toMatchObject({ command: expect.stringContaining('pytest -q') });
    expect(focus.question).toEqual({ kind: 'check_command' }); // typing a different command still works
    expect(lines.join('\n')).toContain('save `');
    expect(hint).toContain('Enter: save that command');
  });

  it('tells the person what only they can fix, and re-checks on Enter', () => {
    const { focus, lines } = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ failureClass: 'environment', evidence: 'ModuleNotFoundError: No module named boto3' })],
    });
    expect(focus.action).toEqual({ kind: 'continue' });
    expect(lines.join('\n')).toContain('dependency is not installed');
    expect(lines.join('\n')).toContain('press Enter');
  });

  it('lets the agent continue from kept work for a code failure, and says when that costs a lot', () => {
    const cheap = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ kind: 'failed', keptBranch: 'taskforge/candidate/1/T1' })],
      spend: { spent: 100_000, budget: 2_000_000 },
    });
    expect(cheap.focus.action).toEqual({ kind: 'continue' });
    expect(cheap.lines.join('\n')).toContain('continue from the work it kept');
    expect(cheap.lines.join('\n')).not.toContain('already used');
    const costly = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ kind: 'failed' })],
      spend: { spent: 1_750_000, budget: 2_000_000 },
    });
    expect(costly.lines.join('\n')).toContain('already used 88% of its token budget');
  });

  it('proposes nothing for a policy stop, and says how to leave', () => {
    const { focus, lines } = buildRunFocus({ runId: 'run-1', repoRoot: repo, failures: [line({ failureClass: 'policy' })] });
    expect(focus.action).toEqual({ kind: 'none' });
    expect(lines.join('\n')).toContain('/back');
  });

  it('a run already past its cap carries a higher cap with whatever it proposes, so it does not stop again at once', () => {
    const { focus, lines, hint } = buildRunFocus({
      runId: 'run-1',
      repoRoot: repo,
      failures: [line({ kind: 'failed', keptBranch: 'taskforge/candidate/1/T1' })],
      spend: { spent: 3_717_115, budget: 2_000_000 },
    });
    expect(focus.action).toEqual({ kind: 'continue' });
    expect(focus.raiseBudgetTo).toBe(4_300_000);
    expect(lines.join('\n')).toContain('already past its token cap (3,717,115 of 2,000,000)');
    expect(lines.join('\n')).toContain('raise the cap to 4,300,000');
    expect(hint).toContain('raise the cap to 4,300,000');
    // Under the cap nothing changes.
    expect(
      buildRunFocus({ runId: 'run-1', repoRoot: repo, failures: [line({ kind: 'failed' })], spend: { spent: 10, budget: 2_000_000 } }).focus.raiseBudgetTo,
    ).toBeUndefined();
  });
});
