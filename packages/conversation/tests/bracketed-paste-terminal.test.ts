import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

async function waitForCondition(predicate: () => boolean, desc: string, timeoutMs = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for condition: ${desc}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Bracketed Paste Terminal Boundary Integration', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-paste-test-'));
    db = new TaskForgeDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    for (const shell of shellsToClean) {
      shell.close();
    }
    shellsToClean.length = 0;
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Requirement 5: processes raw bracketed paste sequence without early submission, strips markers, and preserves newlines and bullets', async () => {
    const inStream = new PassThrough();
    const outStream = new PassThrough();
    let capturedOutput = '';
    outStream.on('data', (d) => {
      capturedOutput += d.toString();
    });

    const shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      input: inStream,
      output: outStream,
      interactive: true,
    });
    shellsToClean.push(shell);

    const planSpy = vi.spyOn(shell.planner, 'plan');

    // Start the REPL loop
    const runPromise = shell.start();

    // Allow REPL initialization
    await new Promise((r) => setTimeout(r, 200));

    const multilineGoal = [
      'Self-Hosting Dogfood Goal:',
      '- 1. Build an end-to-end task execution pipeline across subsystems.',
      '- 2. Ensure CompletionGate verifies commits before marking success.',
      '- 3. Integrate with Git worktree and clean up branches safely.',
    ].join('\n');

    // 1. Send raw bracketed paste sequence: ESC[200~ <multiline text> ESC[201~
    inStream.write(`\x1b[200~${multilineGoal}\x1b[201~`);

    // Wait a tick for readline keypress event loop to process paste chunk
    await new Promise((r) => setTimeout(r, 100));

    // ASSERTION: No plan is created before paste-end and manual Enter!
    expect(planSpy).not.toHaveBeenCalled();
    expect((shell as any).conversationState).toBe('IDLE');
    expect((shell as any).currentGraph).toBeUndefined();

    // 2. Now send manual Enter (\r)
    inStream.write('\r');

    // Wait for planner to be called
    await waitForCondition(() => planSpy.mock.calls.length > 0, 'planner.plan called');

    // ASSERTION: Exactly one submission occurred
    expect(planSpy).toHaveBeenCalledTimes(1);

    // Inspect the goal passed to planner
    const submittedGoal = planSpy.mock.calls[0][0];

    // ASSERTION: Markers are stripped
    expect(submittedGoal.description).not.toContain('\x1b[200~');
    expect(submittedGoal.description).not.toContain('\x1b[201~');
    expect(submittedGoal.description).not.toContain('[200~');
    expect(submittedGoal.description).not.toContain('[201~');

    // ASSERTION: Newlines are preserved
    expect(submittedGoal.description).toContain('\n');
    const lines = submittedGoal.description.split('\n');
    expect(lines.length).toBe(4);

    // ASSERTION: Bullets are preserved
    expect(lines[0]).toBe('Self-Hosting Dogfood Goal:');
    expect(lines[1]).toBe('- 1. Build an end-to-end task execution pipeline across subsystems.');
    expect(lines[2]).toBe('- 2. Ensure CompletionGate verifies commits before marking success.');
    expect(lines[3]).toBe('- 3. Integrate with Git worktree and clean up branches safely.');

    // Wait for plan negotiation and state transition to AWAITING_PLAN_APPROVAL
    await waitForCondition(
      () => (shell as any).conversationState === 'AWAITING_PLAN_APPROVAL',
      'shell enters AWAITING_PLAN_APPROVAL',
    );

    // Verify current graph is populated
    expect((shell as any).currentGraph).toBeDefined();

    // Verify rendered output displayed Plan Proposal with structured tasks
    await waitForCondition(
      () => capturedOutput.includes('Plan Proposal'),
      'captured output has Plan Proposal',
    );
    expect(capturedOutput).toContain('Plan Proposal');

    // 3. Clean exit
    inStream.write('/exit\r');
    await runPromise;
  });
});
