import { describe, it, expect, vi } from 'vitest';
import { StaticRoutingProvider, OpenAIRoutingProvider, AgentSelector } from '../src/index.js';
import { Task } from '@taskforge/core';
import { AgentRegistry, FakeAgent } from '@taskforge/agents';

describe('Router and AgentSelector', () => {
  const sampleTask: Task = {
    id: 'TASK-10',
    goalId: 'goal-10',
    title: 'Investigate flaky concurrent race condition',
    description: 'Find root cause of parallel database transaction deadlock',
    type: 'investigation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Investigate race condition',
      allowedScope: ['*'],
      forbiddenChanges: [],
      acceptanceCriteria: ['Root cause determined'],
      dependencies: [],
    },
    acceptanceCriteria: ['Root cause determined'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('StaticRoutingProvider produces structured routing decision with neutral roles', async () => {
    const provider = new StaticRoutingProvider();
    const decision = await provider.route({
      task: sampleTask,
      availableAgents: ['fake-agent-1', 'fake-agent-2'],
    });

    expect(decision.strategy).toBe('parallel');
    expect(decision.complexity).toBe('high');
    expect(decision.risk).toBe('high');
    expect(decision.roles.length).toBeGreaterThan(1);
    expect(decision.communication.synthesisBeforeImplementation).toBe(true);

    // Roles are neutral abstract roles, not specific agent brands
    for (const role of decision.roles) {
      expect([
        'researcher',
        'reproduction_engineer',
        'architecture_reviewer',
        'lead',
        'implementer',
        'reviewer',
        'tester',
        'security_reviewer',
      ]).toContain(role.role);
      expect(role.requiredCapabilities).toBeInstanceOf(Array);
    }
  });

  it('keeps a simple read-only repository summary single-agent and low complexity', async () => {
    const provider = new StaticRoutingProvider();
    const task: Task = {
      ...sampleTask,
      id: 'TASK-SUMMARY',
      title: 'Investigar e resumir o projeto',
      description: 'Resuma esse projeto para mim',
      type: 'investigation',
      contract: {
        objective: 'Ler o repositório e produzir um resumo claro do projeto',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Resumo entregue'],
        dependencies: [],
        completionMode: 'report',
      },
    };

    const decision = await provider.route({
      task,
      availableAgents: ['claude', 'codex', 'agy'],
    });

    expect(decision.strategy).toBe('single');
    expect(decision.complexity).toBe('low');
    expect(decision.risk).toBe('low');
    expect(decision.teamSize).toBe(1);
    expect(decision.roles).toHaveLength(1);
    expect(decision.roles[0].role).toBe('researcher');
    expect(decision.communication.required).toBe(false);
  });

  it('does not hard-code Claude as the preferred agent for straightforward work', async () => {
    const provider = new StaticRoutingProvider();
    const task: Task = {
      ...sampleTask,
      id: 'TASK-SIMPLE',
      title: 'Add health response header',
      description: 'Add a response header to the health endpoint',
      type: 'implementation',
      contract: {
        objective: 'Add the response header',
        allowedScope: ['src/**'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Header is returned'],
        dependencies: [],
      },
    };

    const decision = await provider.route({
      task,
      availableAgents: ['claude', 'codex', 'agy'],
    });

    expect(decision.strategy).toBe('single');
    expect(decision.roles).toHaveLength(1);
    expect(decision.roles[0].role).toBe('implementer');
    expect(decision.roles[0].preferredAgent).toBeUndefined();
  });

  it('selects the same unpreferred agent regardless of registry insertion order', async () => {
    const makeSelector = (ids: string[]) => {
      const registry = new AgentRegistry(false);
      for (const id of ids) {
        registry.register(new FakeAgent(id, id));
      }
      return new AgentSelector(registry);
    };
    const request = {
      role: 'researcher' as const,
      requiredCapabilities: ['canRead'],
      objective: 'Summarize the repository architecture',
    };
    const context = { selectionKey: '/workspace/example:TASK-01' };

    const first = await makeSelector(['claude', 'codex', 'agy']).selectAgents([request], context);
    const reversed = await makeSelector(['agy', 'codex', 'claude']).selectAgents([request], context);

    expect(first).toHaveLength(1);
    expect(reversed).toHaveLength(1);
    expect(first[0].agent.id).toBe(reversed[0].agent.id);
  });

  it('prefers the least-used eligible agent when no router preference exists', async () => {
    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('claude', 'Claude Code'));
    registry.register(new FakeAgent('codex', 'Codex CLI'));
    registry.register(new FakeAgent('agy', 'Google Antigravity'));

    const history = {
      getAgentSelectionStats(agentId: string, role: string) {
        const roleAssignments: Record<string, number> = {
          claude: 12,
          codex: 3,
          agy: 7,
        };
        return {
          agentId,
          roleAssignments: roleAssignments[agentId] ?? 0,
          totalAssignments: (roleAssignments[agentId] ?? 0) + 5,
          lastAssignedAt: '2026-09-22T12:00:00.000Z',
        };
      },
    };

    const selector = new AgentSelector(registry, { selectionHistory: history });
    const selected = await selector.selectAgents(
      [
        {
          role: 'researcher',
          requiredCapabilities: ['canRead'],
          objective: 'Read and summarize this repository',
        },
      ],
      { selectionKey: '/workspace/example:TASK-01' },
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].agent.id).toBe('codex');
  });

  it('still honors an explicit healthy router preference over fairness history', async () => {
    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('claude', 'Claude Code'));
    registry.register(new FakeAgent('codex', 'Codex CLI'));

    const history = {
      getAgentSelectionStats(agentId: string, role: string) {
        return {
          agentId,
          roleAssignments: agentId === 'claude' ? 50 : 0,
          totalAssignments: agentId === 'claude' ? 100 : 0,
          lastAssignedAt: '2026-09-22T12:00:00.000Z',
        };
      },
    };

    const selector = new AgentSelector(registry, { selectionHistory: history });
    const selected = await selector.selectAgents([
      {
        role: 'architecture_reviewer',
        requiredCapabilities: ['canRead'],
        objective: 'Review architecture invariants',
        preferredAgent: 'claude',
      },
    ]);

    expect(selected).toHaveLength(1);
    expect(selected[0].agent.id).toBe('claude');
  });

  it('OpenAIRoutingProvider gracefully falls back to static provider without API key', async () => {
    const provider = new OpenAIRoutingProvider(undefined);
    const decision = await provider.route({
      task: sampleTask,
      availableAgents: ['agent-a'],
    });

    expect(decision).toBeDefined();
    expect(decision.strategy).toBe('parallel');
  });

  it('reuses fallback during a short provider failure cooldown instead of repeating the same failing HTTP call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const provider = new OpenAIRoutingProvider('test-key', 'gpt-test', 1000);

      const first = await provider.route({
        task: sampleTask,
        availableAgents: ['agent-a'],
      });
      const second = await provider.route({
        task: sampleTask,
        availableAgents: ['agent-a'],
      });

      expect(first.source).toBe('fallback');
      expect(second.source).toBe('fallback');
      expect(first.fallbackReason).toBe('http_error');
      expect(second.fallbackReason).toBe('http_error');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('listAvailableAgentIds excludes quota-blocked providers before routing', async () => {
    const { AgentQuotaTracker } = await import('@taskforge/agents');
    AgentQuotaTracker.resetInstance();
    const tracker = AgentQuotaTracker.getInstance();
    tracker.setManualStatus('agy', 'quota_exhausted', 'resets tomorrow', 60);

    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('codex', 'Codex CLI'));
    registry.register(new FakeAgent('agy', 'Google Antigravity'));
    registry.register(new FakeAgent('claude', 'Claude Code'));

    const selector = new AgentSelector(registry);
    const available = await selector.listAvailableAgentIds();

    expect(available).toEqual(['codex', 'claude']);

    AgentQuotaTracker.resetInstance();
  });

  it('AgentSelector maps neutral role requests to available registered agents', async () => {
    const registry = new AgentRegistry();
    const agent1 = new FakeAgent('fake-1', 'Fake Researcher');
    const agent2 = new FakeAgent('fake-2', 'Fake Implementer');
    registry.register(agent1);
    registry.register(agent2);

    const selector = new AgentSelector(registry);
    const selected = await selector.selectAgents([
      {
        role: 'researcher',
        requiredCapabilities: ['bash', 'file_editor'],
        objective: 'Research root cause',
      },
      { role: 'implementer', requiredCapabilities: ['file_editor', 'git'], objective: 'Fix bug' },
    ]);

    expect(selected.length).toBe(2);
    expect(selected[0].roleRequest.role).toBe('researcher');
    expect(selected[0].agent.id).toBeDefined();
    expect(selected[1].roleRequest.role).toBe('implementer');
    expect(selected[1].agent.id).toBeDefined();
  });

  it('AgentSelector avoids preferredAgent if quota is exhausted and picks healthy agent', async () => {
    const { AgentQuotaTracker } = await import('@taskforge/agents');
    AgentQuotaTracker.resetInstance();
    const tracker = AgentQuotaTracker.getInstance();

    // Mark codex as quota exhausted
    tracker.setManualStatus('codex', 'quota_exhausted', 'limit hit');

    const registry = new AgentRegistry();
    const fakeCodex = new FakeAgent('codex', 'Codex CLI');
    const fakeClaude = new FakeAgent('claude', 'Claude Code');
    registry.register(fakeCodex);
    registry.register(fakeClaude);

    const selector = new AgentSelector(registry);
    // Request role preferring codex
    const selected = await selector.selectAgents([
      {
        role: 'reviewer',
        requiredCapabilities: ['canRead'],
        objective: 'Review code',
        preferredAgent: 'codex',
      },
    ]);

    expect(selected.length).toBe(1);
    // Preferred agent was codex, but codex has exhausted quota, so claude is selected!
    expect(selected[0].agent.id).toBe('claude');
  });

  it('AgentSelector marks staffing as degraded instead of silently duplicating an agent across roles', async () => {
    const registry = new AgentRegistry(false);
    const onlyAgent = new FakeAgent('solo-agent', 'Solo Agent');
    registry.register(onlyAgent);

    const selector = new AgentSelector(registry);
    const selected = await selector.selectAgents([
      { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Implement' },
      { role: 'reviewer', requiredCapabilities: ['canRead'], objective: 'Review' },
    ]);

    expect(selected.length).toBe(2);
    expect(selected[0].agent.id).toBe('solo-agent');
    expect(selected[0].degraded).toBeUndefined();
    expect(selected[1].agent.id).toBe('solo-agent');
    expect(selected[1].degraded).toBe(true);
  });

  it('AgentSelector never returns a quota-exhausted agent, even from its last-ditch/degraded fallbacks', async () => {
    const { AgentQuotaTracker } = await import('@taskforge/agents');
    AgentQuotaTracker.resetInstance();
    const tracker = AgentQuotaTracker.getInstance();

    // Only one agent registered at all, and it's quota-exhausted: every
    // fallback step (capability match, any-ready, and the final degraded
    // reuse) must all refuse to select it.
    tracker.setManualStatus('sole-agent', 'quota_exhausted', 'limit hit');

    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('sole-agent', 'Sole Agent'));

    const selector = new AgentSelector(registry);
    const selected = await selector.selectAgents([
      { role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'Implement' },
    ]);

    // No eligible agent exists -- the role is left unfilled rather than
    // silently staffed with a provider the tracker marked unavailable.
    expect(selected.length).toBe(0);

    AgentQuotaTracker.resetInstance();
  });

  it('AgentSelector.selectAgentForRole finds a distinct replacement while excluding already-tried agents', async () => {
    const { AgentQuotaTracker } = await import('@taskforge/agents');
    AgentQuotaTracker.resetInstance();

    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('agy', 'Google Antigravity'));
    registry.register(new FakeAgent('codex', 'Codex CLI'));
    registry.register(new FakeAgent('claude', 'Claude Code'));

    const selector = new AgentSelector(registry);
    const roleRequest = {
      role: 'researcher' as const,
      requiredCapabilities: ['canRead'],
      objective: 'Investigate root cause',
      preferredAgent: 'agy',
    };

    const first = await selector.selectAgentForRole(roleRequest, {
      excludeAgentIds: new Set(['agy']),
    });
    expect(first?.agent.id).not.toBe('agy');
    expect(first?.roleRequest.role).toBe('researcher');

    const second = await selector.selectAgentForRole(roleRequest, {
      excludeAgentIds: new Set(['agy', first!.agent.id]),
    });
    expect(second?.agent.id).not.toBe('agy');
    expect(second?.agent.id).not.toBe(first!.agent.id);

    const third = await selector.selectAgentForRole(roleRequest, {
      excludeAgentIds: new Set(['agy', first!.agent.id, second!.agent.id]),
    });
    expect(third).toBeUndefined();

    AgentQuotaTracker.resetInstance();
  });
});
