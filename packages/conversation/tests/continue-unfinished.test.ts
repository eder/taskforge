import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository, EventRepository } from '@taskforge/persistence';
import { OperatorIntentParser } from '@taskforge/operator';
import { ClaudeCodeAdapter } from '@taskforge/agents';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('"just ask it to fix it": a message about a run that stopped continues that run', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;
  let resumed: Array<{ runId: string; guidance?: string }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-unfinished-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    resumed = [];
  });
  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedFailedRun(id: string, blocker?: { failureClass: string; evidence: string }) {
    new GoalRepository(db).create({ id: `g-${id}`, description: 'Implement the memory work', repository: dir });
    const runs = new RunRepository(db);
    runs.create(id, `g-${id}`, {});
    runs.updateStatus(id, 'failed');
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(`T-${id}`, id, 'Memory extraction', 'x', 'implementation', 'blocked', new Date().toISOString(), new Date().toISOString());
    if (blocker) {
      new EventRepository(db).append({
        id: `e-${id}`,
        runId: id,
        taskId: `T-${id}`,
        type: 'TASK_RECOVERY_BLOCKED',
        payload: { failureClass: blocker.failureClass, reason: blocker.evidence.split('\n')[0], evidence: blocker.evidence, action: 'block' },
        timestamp: new Date(),
      });
    }
  }

  function stubOrchestrator(s: InteractiveShell) {
    (s as any).buildOrchestrator = () => ({
      checkResumable: async () => undefined,
      resume: async (runId: string, options: { guidance?: string }) => {
        resumed.push({ runId, guidance: options.guidance });
        return { runId, goalId: 'g', status: 'completed', tasksCompleted: 1, tasksFailed: 0, durationMs: 1, graph: { getAllTasks: () => [] } };
      },
    });
  }

  it('hands the user’s own words to the agents as an instruction and continues the failed run', async () => {
    seedFailedRun('run-1790000000000010', { failureClass: 'code_or_test', evidence: 'AssertionError: expected 1 to be 2' });
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    stubOrchestrator(shell);
    (shell as any).planner.setEarlierRunSelector(async () => ({ earlierRunId: 'run-1790000000000010' }));

    const message = 'ajuste os pontos que o revisor levantou';
    await shell.handleInput(message);

    expect(resumed).toEqual([{ runId: 'run-1790000000000010', guidance: message }]);
    // It did not start a new plan for the message.
    expect((shell as any).currentGraph).toBeUndefined();
  });

  it('tells the planner which run is unfinished and why it stopped', async () => {
    seedFailedRun('run-1790000000000011', { failureClass: 'code_or_test', evidence: 'AssertionError: expected 1 to be 2' });
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    stubOrchestrator(shell);
    let offered: Array<{ id: string; state?: string; excerpt: string }> = [];
    (shell as any).planner.setEarlierRunSelector(async (messages: Array<{ content: string }>) => {
      offered = JSON.parse(messages[1].content).recentRuns;
      return { earlierRunId: null };
    });
    await shell.handleInput('implement password reset with token expiry and add tests');
    expect(offered[0]).toMatchObject({ id: 'run-1790000000000011', state: 'not_finished' });
    expect(offered[0].excerpt).toContain('NOT FINISHED (failed)');
    expect(offered[0].excerpt).toContain('AssertionError');
    expect(resumed).toEqual([]); // the planner said it is unrelated: nothing continued
  });

  it('when the run is blocked by something repairable, offers the repair first and keeps the instruction for after it', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(dir, '.env'), 'LLM_API_KEY=x\n');
    seedFailedRun('run-1790000000000012', {
      failureClass: 'environment',
      evidence: 'RuntimeError: no LLM api_key configured\nERROR collecting tests',
    });
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    stubOrchestrator(shell);
    (shell as any).planner.setEarlierRunSelector(async () => ({ earlierRunId: 'run-1790000000000012' }));

    const reply = plain(await shell.handleInput('arrume isso'));

    expect(reply).toContain('stopped on the environment, not on your request');
    expect(reply).toContain('.env');
    expect(reply).toContain('Press Enter');
    expect(resumed).toEqual([]); // nothing runs until the person agrees
    expect((shell as any).suggestedAction).toBe('/fix run-1790000000000012');

    // Enter applies the repair, then continues with the instruction that was waiting.
    const after = plain(await shell.handleInput(''));
    expect(after).not.toContain('Nothing to fix');
    expect(fs.readFileSync(path.join(dir, '.taskforge/config.yaml'), 'utf8')).toContain('.env');
    expect(resumed).toEqual([{ runId: 'run-1790000000000012', guidance: 'arrume isso' }]);
  });

  it('parses /fix with and without a run, and the agent prompt carries the instruction', () => {
    expect(OperatorIntentParser.parse('/fix')).toEqual({ type: 'fix_run', runId: undefined });
    expect(OperatorIntentParser.parse('/fix 2')).toEqual({ type: 'fix_run', runId: '2' });

    const claude = new ClaudeCodeAdapter();
    const assignment = { id: 'a', taskId: 'T', agentId: 'claude', role: 'implementer', objective: 'Fix it', status: 'running' } as const;
    const context = {
      worktreePath: '/tmp/x',
      originalUserRequest: 'Implement the memory work',
      userGuidance: 'fix the reviewer points first',
      assignment,
      mutationAllowed: true,
      task: { objective: 'Fix it', allowedScope: ['**'], forbiddenChanges: [], acceptanceCriteria: ['done'], dependencies: [] },
    };
    const prompt = (claude as any).buildPrompt(assignment, context) as string;
    expect(prompt).toContain('The user asked for this when continuing the run (follow it');
    expect(prompt).toContain('fix the reviewer points first');
    expect((claude as any).buildPrompt(assignment, { ...context, userGuidance: undefined })).not.toContain('when continuing the run');
  });
});
