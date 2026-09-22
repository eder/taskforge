import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timeout waiting for condition: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Focus Mode single-key shortcuts', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-focus-keypress-test-'));
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerAssignment(
    shell: InteractiveShell,
    assignmentId: string,
    agentId: string,
    agentName: string,
  ): void {
    shell.activityTracker.register({
      taskId: 'TASK-FOCUS',
      assignmentId,
      taskTitle: 'Focus-mode navigation test',
      agentId,
      agentName,
      role: 'researcher',
      status: 'Working...',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
  }

  async function startInteractiveShell(shell: InteractiveShell, input: PassThrough): Promise<Promise<void>> {
    const runPromise = shell.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Make sure the keypress listener is attached before emitting synthetic
    // readline keypress events.
    expect(input.listenerCount('keypress')).toBeGreaterThan(0);
    return runPromise;
  }

  it('switches focus immediately with 1-9 when focused and the input buffer is empty, then exits with Esc', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      input,
      output,
      interactive: true,
    });
    shellsToClean.push(shell);

    registerAssignment(shell, 'asgn-1', 'codex', 'Codex CLI');
    registerAssignment(shell, 'asgn-2', 'claude', 'Claude Code');

    await shell.handleInput('/stream TASK-FOCUS');
    expect((shell as any).focusedAssignmentId).toBe('asgn-1');

    const runPromise = await startInteractiveShell(shell, input);

    input.emit('keypress', '2', { name: '2', sequence: '2' });
    expect((shell as any).focusedAssignmentId).toBe('asgn-2');

    input.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b' });
    expect((shell as any).focusedAssignmentId).toBeUndefined();

    input.emit('keypress', undefined, { ctrl: true, name: 'd', sequence: '\x04' });
    await runPromise;
  });

  it('falls through to normal typing when the prompt buffer is non-empty', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      input,
      output,
      interactive: true,
    });
    shellsToClean.push(shell);

    registerAssignment(shell, 'asgn-1', 'codex', 'Codex CLI');
    registerAssignment(shell, 'asgn-2', 'claude', 'Claude Code');

    await shell.handleInput('/stream TASK-FOCUS');
    expect((shell as any).focusedAssignmentId).toBe('asgn-1');

    const runPromise = await startInteractiveShell(shell, input);

    input.emit('keypress', 'x', { name: 'x', sequence: 'x' });
    input.emit('keypress', '2', { name: '2', sequence: '2' });

    // The '2' is ordinary text because the user was already editing a line.
    expect((shell as any).focusedAssignmentId).toBe('asgn-1');

    // Ctrl+C clears the edited buffer without leaving Focus Mode.
    input.emit('keypress', undefined, { ctrl: true, name: 'c', sequence: '\x03' });
    expect((shell as any).focusedAssignmentId).toBe('asgn-1');

    input.emit('keypress', undefined, { ctrl: true, name: 'd', sequence: '\x04' });
    await runPromise;
  });

  it('falls through to normal line input when no assignment is focused', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      input,
      output,
      interactive: true,
    });
    shellsToClean.push(shell);

    const handleInput = vi.spyOn(shell, 'handleInput').mockResolvedValue('ok');
    const runPromise = await startInteractiveShell(shell, input);

    input.emit('keypress', '2', { name: '2', sequence: '2' });
    input.emit('keypress', '\r', { name: 'return', sequence: '\r' });

    await waitForCondition(
      () => handleInput.mock.calls.some(([text]) => text === '2'),
      'normal input submission for digit 2',
    );

    expect((shell as any).focusedAssignmentId).toBeUndefined();

    input.emit('keypress', undefined, { ctrl: true, name: 'd', sequence: '\x04' });
    await runPromise;
  });

  it('keeps /focus <n> and /back behavior unchanged as the Enter-terminated fallback', async () => {
    const shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    shellsToClean.push(shell);

    registerAssignment(shell, 'asgn-1', 'codex', 'Codex CLI');
    registerAssignment(shell, 'asgn-2', 'claude', 'Claude Code');

    await shell.handleInput('/stream TASK-FOCUS');
    const switched = await shell.handleInput('/focus 2');
    expect(switched).toContain('Claude Code');
    expect((shell as any).focusedAssignmentId).toBe('asgn-2');

    const back = await shell.handleInput('/back');
    expect(back).toContain('overview');
    expect((shell as any).focusedAssignmentId).toBeUndefined();
  });

  it('does not enable raw shortcuts in non-interactive/CI mode', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      input,
      output,
      interactive: false,
    });
    shellsToClean.push(shell);

    const handleInput = vi.spyOn(shell, 'handleInput').mockResolvedValue('ok');
    const runPromise = shell.start();

    input.write('2\n');
    input.write('/exit\n');

    await runPromise;

    expect(handleInput).toHaveBeenCalledWith('2');
    expect((shell as any).focusedAssignmentId).toBeUndefined();
  });
});
