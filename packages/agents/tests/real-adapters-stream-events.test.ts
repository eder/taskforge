import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter, CodexAdapter, AntigravityAdapter } from '../src/real-adapters.js';
import type { AgentAssignment, AgentContext, AgentStreamEvent } from '@taskforge/shared';

function makeAssignment(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    id: 'asgn-1',
    taskId: 'TASK-01',
    agentId: 'claude',
    role: 'architecture_reviewer',
    objective: 'Review the module',
    status: 'running',
    ...overrides,
  };
}

function makeContext(onStreamEvent: (e: AgentStreamEvent) => void): AgentContext {
  return {
    worktreePath: '/tmp/fake-worktree',
    task: {
      objective: 'Review the module',
      allowedScope: [],
      forbiddenChanges: [],
      acceptanceCriteria: [],
      dependencies: [],
    },
    assignment: makeAssignment(),
    runId: 'run-1',
    onStreamEvent,
  };
}

describe('BaseCliAdapter.publishStreamEvents', () => {
  it('publishes normalized events with full identity, alongside extractActivity (additive, not a replacement)', () => {
    const claude = new ClaudeCodeAdapter();
    const events: AgentStreamEvent[] = [];
    const context = makeContext((e) => events.push(e));
    const assignment = makeAssignment({ id: 'asgn-claude', role: 'architecture_reviewer' });

    (claude as any).publishStreamEvents(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'server/app.py' } }] },
      }),
      assignment,
      context,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'file_read',
      path: 'server/app.py',
      runId: 'run-1',
      taskId: 'TASK-01',
      assignmentId: 'asgn-claude',
      agentId: 'claude',
      role: 'architecture_reviewer',
    });
  });

  it('does nothing when the context has no onStreamEvent hook (no crash, no-op)', () => {
    const codex = new CodexAdapter();
    const context: AgentContext = {
      worktreePath: '/tmp/fake-worktree',
      task: { objective: 'x', allowedScope: [], forbiddenChanges: [], acceptanceCriteria: [], dependencies: [] },
      assignment: makeAssignment({ agentId: 'codex' }),
    };
    expect(() =>
      (codex as any).publishStreamEvents(
        JSON.stringify({ type: 'item', item: { command: 'ls' } }),
        makeAssignment({ agentId: 'codex' }),
        context,
      ),
    ).not.toThrow();
  });

  it('never throws on malformed chunks even without onStreamEvent guarding it', () => {
    const agy = new AntigravityAdapter();
    const events: AgentStreamEvent[] = [];
    const context = makeContext((e) => events.push(e));
    expect(() =>
      (agy as any).publishStreamEvents('not json {{{ broken', makeAssignment({ agentId: 'agy' }), context),
    ).not.toThrow();
    expect(events).toHaveLength(0);
  });
});
