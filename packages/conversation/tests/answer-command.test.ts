import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentActivityTracker } from '@taskforge/agents';
import { InteractionRepository, TaskForgeDatabase } from '@taskforge/persistence';
import { OperatorIntentParser } from '@taskforge/operator';
import { InteractionRequest } from '@taskforge/shared';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

describe('/answer', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;
  let output: string;
  let repo: InteractionRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-answer-test-'));
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
    output = '';
    repo = new InteractionRepository(db);
  });
  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // closed by the shell
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sink = () =>
    new Writable({
      write(chunk, _enc, cb) {
        output += chunk.toString();
        cb();
      },
    });

  function ask(
    id: string,
    type: InteractionRequest['type'] = 'question',
    prompt = 'Which database?',
  ) {
    repo.createRequest({
      id,
      runId: 'run-1',
      taskId: 'T1',
      assignmentId: `a-${id}`,
      agentId: 'codex',
      type,
      prompt,
      status: 'pending',
      priority: 'normal',
      createdAt: new Date().toISOString(),
    });
  }

  const answerRecorded = (id: string) =>
    db.prepare('SELECT decision, payload FROM interaction_responses WHERE request_id = ?').get(id);

  it('parses the text after the command, keeping it whole', () => {
    expect(OperatorIntentParser.parse('/answer Use PostgreSQL 16')).toEqual({
      type: 'answer_interaction',
      text: 'Use PostgreSQL 16',
    });
    expect(OperatorIntentParser.parse('/answer')).toEqual({ type: 'answer_interaction', text: '' });
  });

  it('shows a question as a question, with the way to answer it, not as a permission', () => {
    const tracker = new AgentActivityTracker();
    shell = new InteractiveShell({
      repoRoot: dir,
      database: db,
      activityTracker: tracker,
      output: sink(),
      interactive: false,
    });
    tracker.register({
      taskId: 'T1',
      assignmentId: 'a1',
      taskTitle: 'Pick storage',
      agentId: 'codex',
      agentName: 'Codex CLI',
      role: 'implementer',
      status: 'Waiting',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
    tracker.setAttention('a1', { type: 'question', requestId: 'req-q', prompt: 'Which database?' });

    const text = plain(output);
    expect(text).toContain('QUESTION FROM AGENT');
    expect(text).toContain('Which database?');
    expect(text).toContain('/answer req-q <your answer>');
    expect(text).not.toContain('allow once');
  });

  it('gives the agent the typed answer, not a yes/no', async () => {
    shell = new InteractiveShell({
      repoRoot: dir,
      database: db,
      output: sink(),
      interactive: false,
    });
    ask('req-1');

    const reply = plain(await shell.handleInput('/answer PostgreSQL, version 16'));

    expect(reply).toContain('ANSWER SENT');
    expect(answerRecorded('req-1')).toMatchObject({
      decision: 'answer',
      payload: 'PostgreSQL, version 16',
    });
  });

  it('targets one question by id when several wait, and refuses to guess otherwise', async () => {
    shell = new InteractiveShell({
      repoRoot: dir,
      database: db,
      output: sink(),
      interactive: false,
    });
    ask('req-a');
    ask('req-b');

    expect(plain(await shell.handleInput('/answer SQLite'))).toContain('Say which one');
    expect(answerRecorded('req-a')).toBeUndefined();

    await shell.handleInput('/answer req-b SQLite');
    expect(answerRecorded('req-b')).toMatchObject({ decision: 'answer', payload: 'SQLite' });
    expect(answerRecorded('req-a')).toBeUndefined();
  });

  it('needs an answer text', async () => {
    shell = new InteractiveShell({
      repoRoot: dir,
      database: db,
      output: sink(),
      interactive: false,
    });
    ask('req-1');
    expect(plain(await shell.handleInput('/answer'))).toContain('Usage: /answer');
    expect(plain(await shell.handleInput('/answer req-1'))).toContain('Usage: /answer');
    expect(answerRecorded('req-1')).toBeUndefined();
  });

  it('does not treat a permission request as something to answer', async () => {
    shell = new InteractiveShell({
      repoRoot: dir,
      database: db,
      output: sink(),
      interactive: false,
    });
    ask('req-p', 'permission', 'Run pnpm test');
    expect(plain(await shell.handleInput('/answer yes'))).toContain(
      'No agent is waiting for an answer',
    );
    expect(answerRecorded('req-p')).toBeUndefined();
  });
});
