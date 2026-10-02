import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('context between runs in the shell', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  function seedRun(id: string, ageHours: number, outputs: Record<string, string>, status = 'completed') {
    new GoalRepository(db).create({ id: `g-${id}`, description: 'Analyse the project', repository: tmpDir });
    const runs = new RunRepository(db);
    runs.create(id, `g-${id}`, { taskOutputs: outputs });
    runs.updateStatus(id, status);
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - ageHours * 3_600_000).toISOString(),
      id,
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ctx-test-'));
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

  const withSelector = (answer: string | null) => {
    const calls: string[] = [];
    (shell as any).planner.setEarlierRunSelector(async (messages: Array<{ content: string }>) => {
      calls.push(messages[1].content);
      return { earlierRunId: answer };
    });
    return calls;
  };

  it('attaches the report when the planner says the request depends on it, in any language', async () => {
    seedRun('run-1790000000000001', 1, { T1: '1. Fix the retry loop\n2. Add tests' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    const calls = withSelector('run-1790000000000001');

    const reply = plain(await shell.handleInput('1番の修正を実装して、回帰テストも追加してください'));

    expect(reply).toContain('Plan Proposal');
    expect(reply).toContain('Context: using the output of run-1790000000000001');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Fix the retry loop');
  });

  it('attaches nothing when the planner says the request stands alone', async () => {
    seedRun('run-1790000000000002', 1, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    withSelector(null);

    const reply = plain(await shell.handleInput('implement password reset with token expiry and add tests'));

    expect(reply).not.toContain('Context: using the output');
  });

  it('ignores a run id the model invented', async () => {
    seedRun('run-1790000000000003', 1, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    withSelector('run-9999999999999999');

    const reply = plain(await shell.handleInput('implement password reset with token expiry and add tests'));

    expect(reply).not.toContain('Context: using the output');
  });

  it('does not ask the model, and attaches nothing, when there is no recent run', async () => {
    seedRun('run-1790000000000004', 72, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    const calls = withSelector('run-1790000000000004');

    const reply = plain(await shell.handleInput('implement item 1 and add regression tests'));

    expect(calls).toHaveLength(0);
    expect(reply).not.toContain('Context: using the output');
  });

  it('without a model, falls back to message length only', async () => {
    seedRun('run-1790000000000005', 1, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    (shell as any).planner.apiKey = undefined;

    const short = plain(await shell.handleInput('do item 1 now'));
    expect(short).toContain('Context: using the output of run-1790000000000005');

    const long = plain(
      await shell.handleInput('implement password reset with token expiry and add regression tests for it'),
    );
    expect(long).not.toContain('Context: using the output');
  });

  it('honours an explicit run id without asking the model', async () => {
    seedRun('run-1790000000000006', 100, { T1: 'old report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    const calls = withSelector(null);

    const reply = plain(await shell.handleInput('implement item 1 from run-1790000000000006 with tests'));

    expect(calls).toHaveLength(0);
    expect(reply).toContain('Context: using the output of run-1790000000000006');
  });

  it('does nothing when context.carryOver is off', async () => {
    seedRun('run-1790000000000007', 1, { T1: 'report' });
    shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
    (shell as any).config.context = { carryOver: false, maxAgeHours: 24, maxChars: 12000 };
    const calls = withSelector('run-1790000000000007');

    const reply = plain(await shell.handleInput('do item 1 now'));

    expect(calls).toHaveLength(0);
    expect(reply).not.toContain('Context: using the output');
  });

  describe('execution intent in a language the patterns do not know', () => {
    it('is read-only when the planner model says so, and the plan is not an implementation', async () => {
      shell = new InteractiveShell({ repoRoot: tmpDir, database: db });
      (shell as any).planner.setIntentJudge(async () => ({ readOnly: true, forbiddenTargets: [] }));

      await shell.handleInput('No modifiques nada del repositorio, solo dime qué falta por hacer');

      expect((shell as any).settledIntent.intent).toBe('READ_ONLY_ANALYSIS');
      expect((shell as any).settledIntent.mutationAllowed).toBe(false);
    });
  });
});
