import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StreamViewer } from '../src/stream-viewer.js';
import { ActiveAgentState } from '@taskforge/shared';

describe('StreamViewer', () => {
  let tmpFile: string | undefined;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  });

  it('renders initializing message when log file does not exist', () => {
    const agent: ActiveAgentState = {
      taskId: 'task-1',
      agentId: 'claude',
      agentName: 'Claude Code',
      status: 'Booting',
      startedAt: new Date(),
      lastActiveAt: new Date(),
      logPath: '/non/existent/path.log',
    };

    const snapshot = StreamViewer.getStreamSnapshot({ activeAgent: agent });
    expect(snapshot).toContain('Live Stream:');
    expect(snapshot).toContain('task-1');
    expect(snapshot).toContain('(Claude Code)');
    expect(snapshot).toContain('No output recorded yet. Agent is initializing...');
    expect(snapshot).toContain('Press [Esc] or type \'q\'');
  });

  it('renders log lines and multiple tabs when log exists', () => {
    tmpFile = path.join(os.tmpdir(), `test-agent-${Date.now()}.log`);
    const logs = ['line 1: start', 'line 2: install deps', 'line 3: run build', 'line 4: done'].join('\n');
    fs.writeFileSync(tmpFile, logs, 'utf8');

    const agent1: ActiveAgentState = {
      taskId: 'task-1',
      agentId: 'claude',
      agentName: 'Claude Code',
      status: 'Working',
      startedAt: new Date(),
      lastActiveAt: new Date(),
      logPath: tmpFile,
    };

    const agent2: ActiveAgentState = {
      taskId: 'task-2',
      agentId: 'codex',
      agentName: 'Codex CLI',
      status: 'Testing',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    };

    const snapshot = StreamViewer.getStreamSnapshot({
      activeAgent: agent1,
      allActive: [agent1, agent2],
      maxLines: 2,
    });

    expect(snapshot).toContain('Live Stream:');
    expect(snapshot).toContain('task-1');
    expect(snapshot).toContain('[1: task-1]');
    expect(snapshot).toContain('[2: task-2]');
    expect(snapshot).toContain('line 3: run build');
    expect(snapshot).toContain('line 4: done');
    expect(snapshot).not.toContain('line 1: start');
  });
});
