import { describe, it, expect } from 'vitest';
import { parseAgentStreamEvents } from '../src/stream-event-parser.js';

const IDENTITY = {
  runId: 'run-1',
  taskId: 'TASK-01',
  assignmentId: 'asgn-1',
  agentId: 'claude',
  role: 'architecture_reviewer',
};

describe('parseAgentStreamEvents', () => {
  it('normalizes a Claude Code structured tool_use (Read) into a file_read event', () => {
    const chunk = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'server/app.py' } }] },
    });
    const events = parseAgentStreamEvents(chunk, IDENTITY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'file_read', path: 'server/app.py', ...IDENTITY });
  });

  it('normalizes Claude Edit/Write/Bash tool_use blocks into the right event types', () => {
    const edit = parseAgentStreamEvents(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] },
      }),
      IDENTITY,
    );
    expect(edit[0]).toMatchObject({ type: 'file_edit', path: 'a.ts' });

    const write = parseAgentStreamEvents(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'b.ts' } }] },
      }),
      IDENTITY,
    );
    expect(write[0]).toMatchObject({ type: 'file_write', path: 'b.ts' });

    const bash = parseAgentStreamEvents(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
      }),
      IDENTITY,
    );
    expect(bash[0]).toMatchObject({ type: 'command_started', command: 'pnpm test' });
  });

  it('normalizes Claude assistant text into an agent_message event', () => {
    const chunk = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'PatternEngine should remain deterministic.' }] },
    });
    const events = parseAgentStreamEvents(chunk, IDENTITY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'agent_message', text: 'PatternEngine should remain deterministic.' });
  });

  it('normalizes a Codex item with a command into a command_started event', () => {
    const chunk = JSON.stringify({ type: 'item', item: { command: 'grep -R "ContextRetrievalEngine" server' } });
    const events = parseAgentStreamEvents(chunk, { ...IDENTITY, agentId: 'codex', role: 'reproduction_engineer' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'command_started', command: 'grep -R "ContextRetrievalEngine" server' });
  });

  it('normalizes a Codex item without a command into a status event', () => {
    const chunk = JSON.stringify({ type: 'item', item: { type: 'reasoning' } });
    const events = parseAgentStreamEvents(chunk, IDENTITY);
    expect(events[0]).toMatchObject({ type: 'status', status: 'reasoning' });
  });

  it('normalizes an Antigravity step_update into a status event', () => {
    const chunk = JSON.stringify({ event: 'step_update', step_update: { description: 'Reading memory.py' } });
    const events = parseAgentStreamEvents(chunk, { ...IDENTITY, agentId: 'agy', role: 'researcher' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status', status: 'Reading memory.py' });
  });

  it('normalizes provider errors and warnings', () => {
    const errEvents = parseAgentStreamEvents(JSON.stringify({ error: 'rate limited' }), IDENTITY);
    expect(errEvents[0]).toMatchObject({ type: 'error', message: 'rate limited' });

    const warnEvents = parseAgentStreamEvents(JSON.stringify({ warning: 'slow response' }), IDENTITY);
    expect(warnEvents[0]).toMatchObject({ type: 'warning', message: 'slow response' });
  });

  it('every event carries full identity (runId/taskId/assignmentId/agentId/role) and a timestamp', () => {
    const chunk = JSON.stringify({ event: 'step_update', step_update: { description: 'Working...' } });
    const [event] = parseAgentStreamEvents(chunk, IDENTITY);
    expect(event.runId).toBe(IDENTITY.runId);
    expect(event.taskId).toBe(IDENTITY.taskId);
    expect(event.assignmentId).toBe(IDENTITY.assignmentId);
    expect(event.agentId).toBe(IDENTITY.agentId);
    expect(event.role).toBe(IDENTITY.role);
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('ignores malformed JSON lines and plain non-JSON chrome without throwing', () => {
    const chunk = ['not json at all', '{broken json', JSON.stringify({ error: 'real error' })].join('\n');
    const events = parseAgentStreamEvents(chunk, IDENTITY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'real error' });
  });

  it('parses multiple events out of a single multi-line chunk, in order', () => {
    const chunk = [
      JSON.stringify({ type: 'item', item: { command: 'ls' } }),
      JSON.stringify({ event: 'step_update', step_update: { description: 'Listing files' } }),
    ].join('\n');
    const events = parseAgentStreamEvents(chunk, IDENTITY);
    expect(events.map((e) => e.type)).toEqual(['command_started', 'status']);
  });
});
