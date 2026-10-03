import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskForgeDatabase, RunRepository, GoalRepository, EventRepository } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('the REPL goes into a run that stopped', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;
  let resumes: Array<{ runId: string; guidance?: string; tokenBudget?: number }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-focusrepl-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.taskforge/\ntest.db*\n');
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    resumes = [];
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

  function seed(id: string, event: { failureClass: string; evidence: string }) {
    new GoalRepository(db).create({ id: `g-${id}`, description: 'Implement the memory work', repository: dir });
    const runs = new RunRepository(db);
    runs.create(id, `g-${id}`, {});
    runs.updateStatus(id, 'failed');
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(`T-${id}`, id, 'Memory extraction', 'x', 'implementation', 'blocked', new Date().toISOString(), new Date().toISOString());
    new EventRepository(db).append({
      id: `e-${id}`,
      runId: id,
      taskId: `T-${id}`,
      type: 'TASK_RECOVERY_BLOCKED',
      payload: { failureClass: event.failureClass, reason: event.evidence.split('\n')[0], evidence: event.evidence, action: 'block' },
      timestamp: new Date(),
    });
  }

  function open(): InteractiveShell {
    const s = new InteractiveShell({ repoRoot: dir, database: db });
    (s as any).buildOrchestrator = () => ({
      checkResumable: async () => undefined,
      resume: async (runId: string, options: { guidance?: string; tokenBudget?: number }) => {
        resumes.push({ runId, guidance: options.guidance, tokenBudget: options.tokenBudget });
        return { runId, goalId: 'g', status: 'completed', tasksCompleted: 1, tasksFailed: 0, durationMs: 1, graph: { getAllTasks: () => [] } };
      },
    });
    return s;
  }

  const stopped = (s: InteractiveShell, id: string) =>
    (s as any).formatRunSummary({ runId: id, goalId: 'g', status: 'failed', tasksCompleted: 0, tasksFailed: 1, durationMs: 5, graph: { getAllTasks: () => [] }, error: 'x' }) as Promise<string>;

  it('says what happened and what it would do, in words, with no command to run elsewhere', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'LLM_API_KEY=x\n');
    seed('run-1790000000000020', { failureClass: 'environment', evidence: 'RuntimeError: no LLM api_key configured' });
    shell = open();

    const text = plain(await stopped(shell, 'run-1790000000000020'));

    expect(text).toContain("What I'd do:");
    expect(text).toContain('.env');
    expect(text).toContain('↵ Enter: fix this and continue');
    expect(text).toContain('or just tell me what you want');
    expect(text).not.toMatch(/\btf (fix|resume|abandon|inspect)\b/);
    expect((shell as any).focusedRun).toMatchObject({ runId: 'run-1790000000000020', action: { kind: 'fix' } });
  });

  it('Enter repairs and continues the run, and a plain yes does the same', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'LLM_API_KEY=x\n');
    seed('run-1790000000000021', { failureClass: 'environment', evidence: 'RuntimeError: no LLM api_key configured' });
    shell = open();
    await stopped(shell, 'run-1790000000000021');

    await shell.handleInput('');

    expect(fs.readFileSync(path.join(dir, '.taskforge/config.yaml'), 'utf8')).toContain('.env');
    expect(resumes).toEqual([{ runId: 'run-1790000000000021', guidance: undefined, tokenBudget: undefined }]);
    expect((shell as any).focusedRun).toBeUndefined();

    resumes.length = 0;
    seed('run-1790000000000022', { failureClass: 'code_or_test', evidence: 'AssertionError: 1 != 2' });
    await stopped(shell, 'run-1790000000000022');
    await shell.handleInput('yes');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe('run-1790000000000022');
  });

  it('raises the cap and continues when the run stopped at its token cap', async () => {
    seed('run-1790000000000023', { failureClass: 'code_or_test', evidence: 'x' });
    new EventRepository(db).append({
      id: 'budget-23',
      runId: 'run-1790000000000023',
      type: 'TOKEN_BUDGET_REACHED',
      payload: { spent: 2_010_000, budget: 2_000_000 },
      timestamp: new Date(Date.now() + 1000),
    });
    shell = open();
    const text = plain(await stopped(shell, 'run-1790000000000023'));
    expect(text).toContain('raise the cap to 4,000,000 tokens and continue');

    await shell.handleInput('');

    expect(resumes[0]).toMatchObject({ runId: 'run-1790000000000023', tokenBudget: 4_000_000 });
  });

  it('a message goes to that run as the user’s instruction; no model needed', async () => {
    seed('run-1790000000000024', { failureClass: 'code_or_test', evidence: 'AssertionError: 1 != 2' });
    shell = open();
    await stopped(shell, 'run-1790000000000024');

    await shell.handleInput('use the smaller fixture set');

    expect(resumes).toEqual([{ runId: 'run-1790000000000024', guidance: 'use the smaller fixture set', tokenBudget: undefined }]);
  });

  it('leaves the run when the planner says the message is a new task', async () => {
    seed('run-1790000000000025', { failureClass: 'code_or_test', evidence: 'AssertionError: 1 != 2' });
    shell = open();
    (shell as any).planner.setEarlierRunSelector(async () => ({ earlierRunId: null }));
    await stopped(shell, 'run-1790000000000025');

    const reply = plain(await shell.handleInput('implement password reset with token expiry and add tests'));

    expect(resumes).toEqual([]);
    expect(reply).toContain('Plan Proposal');
    expect((shell as any).focusedRun).toBeUndefined();
  });

  it('asks how to start the service it cannot find, runs what the person types, and continues once the port is up', async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
    seed('run-1790000000000026', { failureClass: 'environment', evidence: `OSError: [Errno 61] Connect call failed ('127.0.0.1', ${free})` });
    shell = open();
    const text = plain(await stopped(shell, 'run-1790000000000026'));
    expect(text).toContain(`port ${free}`);
    expect(text).toContain('type the command that starts it');

    // The typed command starts a short-lived listener, like `docker compose up -d db` would start a service.
    const command = `nohup node -e "const s=require('net').createServer().listen(${free},'127.0.0.1');setTimeout(()=>s.close(),6000)" >/dev/null 2>&1 &`;
    await shell.handleInput(command);

    expect(resumes).toHaveLength(1);
    expect(resumes[0].runId).toBe('run-1790000000000026');
  }, 60_000);

  it('asks which command verifies the project, saves it, and re-checks', async () => {
    seed('run-1790000000000027', { failureClass: 'verification_configuration', evidence: 'sh: pytest: command not found' });
    shell = open();
    const text = plain(await stopped(shell, 'run-1790000000000027'));
    expect(text).toContain('type the command that verifies this project');

    await shell.handleInput('pytest -q server');

    expect(fs.readFileSync(path.join(dir, '.taskforge/config.yaml'), 'utf8')).toContain('pytest -q server');
    expect(resumes).toHaveLength(1);
  });

  it('/back leaves the run, and a plain "no" does too', async () => {
    seed('run-1790000000000028', { failureClass: 'code_or_test', evidence: 'x' });
    shell = open();
    await stopped(shell, 'run-1790000000000028');
    await shell.handleInput('no');
    expect((shell as any).focusedRun).toBeUndefined();
    expect(resumes).toEqual([]);
  });
});

describe('an unexpected error does not leave a dead run and a raw message', () => {
  it('says the work is kept and leaves the run ready to try again with Enter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-unexpected-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    new RunRepository(db).create('run-1790000000000040', undefined, {});
    new RunRepository(db).updateStatus('run-1790000000000040', 'failed');
    const shell = new InteractiveShell({ repoRoot: dir, database: db });
    (shell as any).buildOrchestrator = () => ({
      checkResumable: async () => undefined,
      resume: async () => {
        throw new Error('Failed to integrate task TASK-12 (commit abc): Git command failed: git cherry-pick abc\nhint: After resolving the conflicts');
      },
    });
    const reply = plain(await shell.handleInput('/retry run-1790000000000040'));
    expect(reply).toContain('Something went wrong inside TaskForge while running run-1790000000000040');
    expect(reply).toContain('Nothing was applied to your branch');
    expect(reply).toContain('Enter: try again from where it stopped');
    expect(reply).not.toContain('hint:'); // only the first line, never the git advice block
    expect((shell as any).focusedRun).toMatchObject({ runId: 'run-1790000000000040', action: { kind: 'continue' } });
    shell.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
