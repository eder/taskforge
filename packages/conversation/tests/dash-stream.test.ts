import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoalRepository, RunRepository, TaskForgeDatabase } from '@taskforge/persistence';
import { DashStreamSession, LogTailer } from '../src/dash-stream.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

const readLine = (file: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] },
  });

describe('LogTailer', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-tail-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns nothing for a file that does not exist yet', () => {
    expect(new LogTailer(path.join(dir, 'missing.log')).readNewLines()).toEqual([]);
  });

  it('returns only lines added since the last read and holds back a half-written one', () => {
    const file = path.join(dir, 'a.log');
    const tailer = new LogTailer(file);
    fs.writeFileSync(file, 'one\ntw');
    expect(tailer.readNewLines()).toEqual(['one']);
    fs.appendFileSync(file, 'o\nthree\n');
    expect(tailer.readNewLines()).toEqual(['two', 'three']);
    expect(tailer.readNewLines()).toEqual([]);
  });

  it('starts over when the file is replaced by a shorter one', () => {
    const file = path.join(dir, 'a.log');
    const tailer = new LogTailer(file);
    fs.writeFileSync(file, 'a long first line\n');
    tailer.readNewLines();
    fs.writeFileSync(file, 'new\n');
    expect(tailer.readNewLines()).toEqual(['new']);
  });
});

describe('DashStreamSession', () => {
  let dir: string;
  let db: TaskForgeDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-dash-test-'));
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    new GoalRepository(db).create({ id: 'g1', description: 'goal', repository: dir });
    new RunRepository(db).create('run-1', 'g1', {});
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function addExecution(n: number, opts: { pid?: number | null; status?: string; log?: string }) {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, type, status, rework_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(`T${n}`, 'run-1', `Task ${n}`, 'x', 'implementation', 'running', now, now);
    db.prepare(
      'INSERT INTO assignments (id, task_id, run_id, agent_id, role, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `A${n}`,
      `T${n}`,
      'run-1',
      n === 1 ? 'claude' : 'codex',
      'implementer',
      'obj',
      'running',
      now,
      now,
    );
    const log = path.join(dir, `${n}.log`);
    fs.writeFileSync(log, opts.log ?? '');
    db.prepare(
      'INSERT INTO executions (id, run_id, task_id, assignment_id, agent_id, pid, started_at, status, log_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `E${n}`,
      'run-1',
      `T${n}`,
      `A${n}`,
      n === 1 ? 'claude' : 'codex',
      opts.pid === undefined ? process.pid : opts.pid,
      now,
      opts.status ?? 'running',
      log,
    );
    return log;
  }

  it('says so when nothing is running', () => {
    const session = new DashStreamSession(db);
    session.refresh();
    expect(session.agentCount).toBe(0);
    expect(plain(session.render())).toContain('No agent is running right now');
  });

  it('shows each running agent as a tab and the focused one’s events, in parallel', () => {
    addExecution(1, { log: readLine('src/a.ts') + '\n' });
    addExecution(2, { log: readLine('src/b.ts') + '\n' });
    const session = new DashStreamSession(db);
    session.refresh();

    expect(session.agentCount).toBe(2);
    let view = plain(session.render());
    expect(view).toContain('[1] claude');
    expect(view).toContain('[2] codex');
    expect(view).toContain('src/a.ts');
    expect(view).not.toContain('src/b.ts');

    session.focus(2);
    view = plain(session.render());
    expect(view).toContain('src/b.ts');
    expect(view).not.toContain('src/a.ts');
  });

  it('picks up lines the agent writes later, without repeating earlier ones', () => {
    const log = addExecution(1, { log: readLine('one.ts') + '\n' });
    const session = new DashStreamSession(db);
    session.refresh();
    fs.appendFileSync(log, readLine('two.ts') + '\n');
    session.refresh();

    const view = plain(session.render());
    expect(view).toContain('one.ts');
    expect(view).toContain('two.ts');
    expect(view.match(/one\.ts/g)).toHaveLength(1);
  });

  it('ignores finished executions and stale ones whose process is gone', () => {
    addExecution(1, { status: 'success' });
    addExecution(2, { pid: 2 ** 22 + 12345 }); // no such process
    const session = new DashStreamSession(db);
    session.refresh();
    expect(session.agentCount).toBe(0);
  });

  it('ignores a focus key that has no agent', () => {
    addExecution(1, {});
    const session = new DashStreamSession(db);
    session.refresh();
    session.focus(7);
    expect(plain(session.render())).toContain('T1  claude › implementer');
  });
});
