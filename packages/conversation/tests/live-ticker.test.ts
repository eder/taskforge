import { describe, it, expect } from 'vitest';
import { LiveTicker } from '../src/live-ticker.js';
import { ActiveAgentState } from '@taskforge/shared';

describe('LiveTicker', () => {
  it('returns empty lines when there are no active agents', () => {
    const lines = LiveTicker.render({ activeAgents: [] });
    expect(lines).toEqual([]);
  });

  it('formats duration correctly for seconds and minutes', () => {
    const now = Date.now();
    const tenSecAgo = new Date(now - 10000);
    expect(LiveTicker.formatDuration(tenSecAgo)).toBe('10s');

    const twoMinAgo = new Date(now - 125000);
    expect(LiveTicker.formatDuration(twoMinAgo)).toBe('2m 05s');
  });

  it('renders active agents with spinner, name, status, and duration', () => {
    const active: ActiveAgentState[] = [
      {
        taskId: 'task-1',
        agentId: 'claude',
        agentName: 'Claude Code',
        status: 'Editing auth.ts',
        startedAt: new Date(Date.now() - 5000),
        lastActiveAt: new Date(),
      },
    ];

    const lines = LiveTicker.render({
      activeAgents: active,
      registeredAgents: [
        { id: 'claude', name: 'Claude Code' },
        { id: 'codex', name: 'Codex CLI' },
      ],
      frameIndex: 0,
    });

    expect(lines.length).toBeGreaterThanOrEqual(2);
    const joined = lines.join('\n');
    expect(joined).toContain('task-1');
    expect(joined).toContain('Claude Code');
    expect(joined).toContain('Editing auth.ts');
    expect(joined).toContain('Free: Codex CLI');
    expect(joined).toContain('/stream');
  });

  it('renders attention alert banner when an agent needs human decision', () => {
    const active: ActiveAgentState[] = [
      {
        taskId: 'task-9',
        agentId: 'codex',
        agentName: 'Codex CLI',
        status: 'Waiting',
        startedAt: new Date(),
        lastActiveAt: new Date(),
        attentionRequired: {
          type: 'permission',
          prompt: 'Execute command: git reset --hard origin/main',
        },
      },
    ];

    const lines = LiveTicker.render({ activeAgents: active });
    const joined = lines.join('\n');
    expect(joined).toContain('▲ ATTENTION');
    expect(joined).toContain('task-9');
    expect(joined).toContain('Execute command: git reset');
    expect(joined).toContain('type "allow" or "/deny"');
  });

  it('truncates overflow if more than 3 agents are active', () => {
    const active: ActiveAgentState[] = [1, 2, 3, 4, 5].map((i) => ({
      taskId: `task-${i}`,
      agentId: `agent-${i}`,
      agentName: `Agent ${i}`,
      status: `Working on step ${i}`,
      startedAt: new Date(),
      lastActiveAt: new Date(),
    }));

    const lines = LiveTicker.render({ activeAgents: active });
    const joined = lines.join('\n');
    expect(joined).toContain('task-1');
    expect(joined).toContain('task-2');
    expect(joined).toContain('task-3');
    expect(joined).not.toContain('task-4');
    expect(joined).toContain('... and 2 more agent(s) working concurrently');
  });

  it('highlights critical review findings inline with file and line references', () => {
    const active: ActiveAgentState[] = [
      {
        taskId: 'TASK-SEC-1',
        agentId: 'claude',
        agentName: 'Claude Code',
        status: 'Reviewing security vulnerabilities',
        startedAt: new Date(),
        lastActiveAt: new Date(),
        criticalFindings: [
          {
            severity: 'critical',
            description: 'SQL Injection vulnerability in query builder',
            file: 'src/db/query.ts',
            line: 42,
          },
        ],
      },
    ];

    const lines = LiveTicker.render({ activeAgents: active });
    const joined = lines.join('\n');
    expect(joined).toContain('✖ [CRITICAL]');
    expect(joined).toContain('TASK-SEC-1');
    expect(joined).toContain('src/db/query.ts:42');
    expect(joined).toContain('SQL Injection vulnerability');
  });
});
