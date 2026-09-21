import { describe, it, expect } from 'vitest';
import { ActiveAgentState, InteractionRequest, InvestigatorFailoverEvent } from '@taskforge/shared';
import { CockpitPanels } from '../src/cockpit-panels.js';

describe('CockpitPanels', () => {
  it('renders a full ACTION REQUIRED panel with agent, task, operation, resource, reason and response commands', () => {
    const state: ActiveAgentState = {
      taskId: 'TASK-42',
      assignmentId: 'asgn-42',
      taskTitle: 'Update checkout flow',
      agentId: 'codex',
      agentName: 'Codex CLI',
      role: 'implementer',
      status: 'Waiting for permission',
      startedAt: new Date(),
      lastActiveAt: new Date(),
      attentionRequired: {
        type: 'permission',
        requestId: 'req-123',
        category: 'commands',
        operation: 'run',
        resource: 'pnpm test',
        prompt: 'The agent needs to run the repository test suite.',
      },
    };

    const panel = CockpitPanels.actionRequired(state);

    expect(panel).toContain('ACTION REQUIRED');
    expect(panel).toContain('Codex CLI');
    expect(panel).toContain('TASK-42');
    expect(panel).toContain('run');
    expect(panel).toContain('pnpm test');
    expect(panel).toContain('The agent needs to run the repository test suite.');
    expect(panel).toContain('/approve req-123 once');
    expect(panel).toContain('/approve req-123 task');
    expect(panel).toContain('/deny req-123');
    expect(panel).toContain('/pending');
  });

  it('renders allowed and denied interaction outcomes clearly', () => {
    const request: InteractionRequest = {
      id: 'req-456',
      runId: 'run-1',
      taskId: 'TASK-1',
      assignmentId: 'asgn-1',
      agentId: 'claude',
      type: 'permission',
      prompt: 'Install package',
      category: 'commands',
      resource: 'pnpm add zod',
      status: 'pending',
      priority: 'normal',
      createdAt: new Date().toISOString(),
    };

    const allowed = CockpitPanels.interactionResolved(request, 'allow', 'once');
    expect(allowed).toContain('ACTION ALLOWED');
    expect(allowed).toContain('Permission granted');
    expect(allowed).toContain('scope: once');
    expect(allowed).toContain('pnpm add zod');

    const denied = CockpitPanels.interactionResolved(request, 'deny', 'once');
    expect(denied).toContain('ACTION DENIED');
    expect(denied).toContain('Permission denied');
    expect(denied).toContain('agent notified');
  });

  it('renders failover recovery with failed and replacement agent names, role, reason and reset time', () => {
    const event: InvestigatorFailoverEvent = {
      type: 'investigator_failover',
      stage: 'recovered',
      timestamp: new Date(),
      runId: 'run-2',
      taskId: 'TASK-9',
      assignmentId: 'asgn-retry',
      agentId: 'claude',
      role: 'researcher',
      failedAgentId: 'agy',
      failedAgentName: 'Google Antigravity',
      replacementAgentId: 'claude',
      replacementAgentName: 'Claude Code',
      reason: 'Quota exhausted',
      resetAt: '2026-09-24T08:00:00.000Z',
    };

    const panel = CockpitPanels.failover(event);

    expect(panel).toContain('PROVIDER RECOVERED');
    expect(panel).toContain('Google Antigravity');
    expect(panel).toContain('Claude Code');
    expect(panel).toContain('researcher');
    expect(panel).toContain('Quota exhausted');
    expect(panel).toContain('2026-09-24T08:00:00.000Z');
    expect(panel).toContain('Recovered');
  });
});
