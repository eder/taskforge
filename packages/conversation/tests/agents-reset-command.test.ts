import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentQuotaTracker } from '@taskforge/agents';
import { OperatorIntentParser } from '@taskforge/operator';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '../src/interactive-shell.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('/agents reset', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-reset-test-'));
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // closed by the shell
    }
    AgentQuotaTracker.resetInstance();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses with and without an agent, and leaves plain /agents alone', () => {
    expect(OperatorIntentParser.parse('/agents reset agy')).toEqual({
      type: 'reset_agent',
      agentId: 'agy',
    });
    expect(OperatorIntentParser.parse('/agents reset')).toEqual({
      type: 'reset_agent',
      agentId: undefined,
    });
    expect(OperatorIntentParser.parse('/agents')).toEqual({ type: 'inspect_agents' });
  });

  it('forgets a recorded failure so the agent is tried again', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    AgentQuotaTracker.getInstance().recordFailure('agy', 'Individual quota reached');
    expect(AgentQuotaTracker.getInstance().isAvailable('agy')).toBe(false);

    const reply = plain(await shell.handleInput('/agents reset agy'));

    expect(reply).toContain('Forgot the recorded quota exhausted for agy');
    expect(AgentQuotaTracker.getInstance().isAvailable('agy')).toBe(true);
  });

  it('says so when there is nothing to reset, and what to type when no agent is named', async () => {
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    expect(plain(await shell.handleInput('/agents reset codex'))).toContain('nothing to reset');
    expect(plain(await shell.handleInput('/agents reset'))).toContain('Usage: /agents reset');
  });
});
