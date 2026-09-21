import { describe, it, expect } from 'vitest';
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

  it('OpenAIRoutingProvider gracefully falls back to static provider without API key', async () => {
    const provider = new OpenAIRoutingProvider(undefined);
    const decision = await provider.route({
      task: sampleTask,
      availableAgents: ['agent-a'],
    });

    expect(decision).toBeDefined();
    expect(decision.strategy).toBe('parallel');
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

  it('AgentSelector never resurrects an unavailable agent in fallback paths', async () => {
    const { AgentQuotaTracker } = await import('@taskforge/agents');
    AgentQuotaTracker.resetInstance();
    const tracker = AgentQuotaTracker.getInstance();
    tracker.setManualStatus('only-agent', 'quota_exhausted', 'provider quota exhausted');

    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('only-agent', 'Only Agent'));

    const selector = new AgentSelector(registry);
    const selected = await selector.selectAgents([
      {
        role: 'researcher',
        requiredCapabilities: ['canRead'],
        objective: 'Investigate the issue',
        preferredAgent: 'only-agent',
      },
    ]);

    expect(selected).toHaveLength(0);
    AgentQuotaTracker.resetInstance();
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
});
