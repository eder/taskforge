import { describe, it, expect } from 'vitest';
import {
  StaticRoutingProvider,
  OpenAIRoutingProvider,
  AgentSelector,
} from '../src/index.js';
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
      { role: 'researcher', requiredCapabilities: ['bash', 'file_editor'], objective: 'Research root cause' },
      { role: 'implementer', requiredCapabilities: ['file_editor', 'git'], objective: 'Fix bug' },
    ]);

    expect(selected.length).toBe(2);
    expect(selected[0].roleRequest.role).toBe('researcher');
    expect(selected[0].agent.id).toBeDefined();
    expect(selected[1].roleRequest.role).toBe('implementer');
    expect(selected[1].agent.id).toBeDefined();
  });
});
