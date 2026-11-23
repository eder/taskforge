import { describe, it, expect } from 'vitest';
import type { AgentContext } from '@taskforge/shared';
import { ClaudeCodeAdapter } from '../src/claude-code-adapter.js';
import { CodexAdapter } from '../src/codex-adapter.js';
import { AntigravityAdapter } from '../src/antigravity-adapter.js';

function makeDirectContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    worktreePath: '/tmp/repo',
    directMode: true,
    mutationAllowed: false,
    task: {
      objective: 'Explain auth flow',
      allowedScope: [],
      forbiddenChanges: ['*'],
      acceptanceCriteria: ['Answer clearly'],
      dependencies: [],
    },
    assignment: {
      id: 'direct-1',
      taskId: 'DIRECT',
      agentId: 'codex',
      role: 'researcher',
      objective: 'Explain auth flow',
      status: 'running',
    },
    ...overrides,
  };
}

describe('Provider-native session continuity (Direct Mode)', () => {
  it('extracts providerSessionId from Claude, Codex, and Antigravity stream outputs', () => {
    const claude = new ClaudeCodeAdapter();
    const claudeOutcome = claude.normalizeOutcome(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-sess-123' }),
        JSON.stringify({ type: 'result', session_id: 'claude-sess-123', result: 'All good.' }),
      ].join('\n'),
      '',
      0,
    );
    expect(claudeOutcome.providerSessionId).toBe('claude-sess-123');
    expect(claudeOutcome.finalResponse).toBe('All good.');

    const codex = new CodexAdapter();
    const codexOutcome = codex.normalizeOutcome(
      [
        JSON.stringify({ type: 'thread.started', thread_id: '0195c-thread-uuid' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Codex reply' },
        }),
      ].join('\n'),
      '',
      0,
    );
    expect(codexOutcome.providerSessionId).toBe('0195c-thread-uuid');
    expect(codexOutcome.finalResponse).toBe('Codex reply');

    const agy = new AntigravityAdapter();
    const agyOutcome = agy.normalizeOutcome(
      JSON.stringify({
        event: 'result',
        conversation_id: 'agy-conv-789',
        result: { status: 'SUCCESS', response: 'AGY reply' },
      }),
      '',
      0,
    );
    expect(agyOutcome.providerSessionId).toBe('agy-conv-789');
    expect(agyOutcome.finalResponse).toBe('AGY reply');
  });

  it('omits --no-session-persistence and passes --resume for Claude in Direct Mode', () => {
    const adapter = new ClaudeCodeAdapter() as unknown as {
      formatArgs(prompt: string, context?: AgentContext): string[];
    };

    // Orchestrated default keeps --no-session-persistence
    const orchestrated = adapter.formatArgs('task', makeDirectContext({ directMode: false }));
    expect(orchestrated).toContain('--no-session-persistence');
    expect(orchestrated).not.toContain('--resume');

    // First direct turn with persistProviderSession drops --no-session-persistence
    const firstTurn = adapter.formatArgs(
      'hi',
      makeDirectContext({ persistProviderSession: true }),
    );
    expect(firstTurn).not.toContain('--no-session-persistence');
    expect(firstTurn).not.toContain('--resume');

    // Subsequent direct turn injects --resume <id> before -p
    const resumed = adapter.formatArgs(
      'follow up',
      makeDirectContext({ persistProviderSession: true, providerSessionId: 'claude-sess-123' }),
    );
    expect(resumed).not.toContain('--no-session-persistence');
    const resumeIdx = resumed.indexOf('--resume');
    const promptFlagIdx = resumed.indexOf('-p');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(resumed[resumeIdx + 1]).toBe('claude-sess-123');
    expect(resumeIdx).toBeLessThan(promptFlagIdx);
  });

  it('omits --ephemeral and uses `exec resume` for Codex in Direct Mode', () => {
    const adapter = new CodexAdapter() as unknown as {
      formatArgs(prompt: string, context?: AgentContext): string[];
    };

    // Orchestrated default keeps --ephemeral
    const orchestrated = adapter.formatArgs('task', makeDirectContext({ directMode: false }));
    expect(orchestrated).toContain('--ephemeral');
    expect(orchestrated).not.toContain('resume');

    // First direct turn drops --ephemeral so thread_id is persisted
    const firstTurn = adapter.formatArgs(
      'hi',
      makeDirectContext({ persistProviderSession: true }),
    );
    expect(firstTurn).not.toContain('--ephemeral');
    expect(firstTurn).toContain('--sandbox');
    expect(firstTurn).toContain('read-only');

    // Follow-up direct turn uses `codex exec resume --json -c sandbox_mode=... <id> <prompt>`
    const resumedReadOnly = adapter.formatArgs(
      'follow up',
      makeDirectContext({
        persistProviderSession: true,
        providerSessionId: '0195c-thread-uuid',
        mutationAllowed: false,
      }),
    );
    expect(resumedReadOnly.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(resumedReadOnly).toContain('sandbox_mode="read-only"');
    expect(resumedReadOnly.slice(-2)).toEqual(['0195c-thread-uuid', 'follow up']);

    const resumedWrite = adapter.formatArgs(
      'edit file',
      makeDirectContext({
        persistProviderSession: true,
        providerSessionId: '0195c-thread-uuid',
        mutationAllowed: true,
        task: {
          objective: 'edit file',
          allowedScope: ['**'],
          forbiddenChanges: [],
          acceptanceCriteria: [],
          dependencies: [],
        },
      }),
    );
    expect(resumedWrite).toContain('sandbox_mode="workspace-write"');
  });

  it('passes --conversation <id> for Antigravity when resuming a direct session', () => {
    const adapter = new AntigravityAdapter() as unknown as {
      formatArgs(prompt: string, context?: AgentContext): string[];
    };

    const resumed = adapter.formatArgs(
      'follow up',
      makeDirectContext({ persistProviderSession: true, providerSessionId: 'agy-conv-789' }),
    );
    const convIdx = resumed.indexOf('--conversation');
    const promptFlagIdx = resumed.indexOf('-p');
    expect(convIdx).toBeGreaterThanOrEqual(0);
    expect(resumed[convIdx + 1]).toBe('agy-conv-789');
    expect(convIdx).toBeLessThan(promptFlagIdx);
  });
});
