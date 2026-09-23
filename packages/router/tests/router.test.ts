import { describe, it, expect, vi } from 'vitest';
import {
  StaticRoutingProvider,
  OpenAIRoutingProvider,
  AgentSelector,
  RouterQualityGuard,
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

  it('forces an over-staffed router proposal to SINGLE for a lightweight read-only overview', () => {
    const task: Task = {
      ...sampleTask,
      id: 'TASK-OVERVIEW',
      title: 'Explain Project and Architecture',
      description: 'Read the repository and answer: O que é esse projeto?',
      type: 'investigation',
      contract: {
        objective: 'Explain the current repository using repository evidence only: O que é esse projeto?',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Repository-grounded explanation'],
        dependencies: [],
        completionMode: 'report',
        metadata: { lightweightReadOnlyInvariant: true },
      },
    };

    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 3,
        roles: [
          { role: 'reproduction_engineer', requiredCapabilities: ['canRead'], objective: 'Read files' },
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'Research' },
          { role: 'architecture_reviewer', requiredCapabilities: ['canRead'], objective: 'Review' },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Model over-staffed a simple question',
        source: 'openai',
      },
      { task, availableAgents: ['claude', 'codex', 'agy'] },
    );

    expect(guarded.strategy).toBe('single');
    expect(guarded.complexity).toBe('low');
    expect(guarded.risk).toBe('low');
    expect(guarded.teamSize).toBe(1);
    expect(guarded.roles).toHaveLength(1);
    expect(guarded.roles[0].role).toBe('researcher');
    expect(guarded.communication?.required).toBe(false);
  });

  it('canonicalizes a dedicated review task to one read-only reviewer', () => {
    const task: Task = {
      ...sampleTask,
      id: 'TASK-REVIEW',
      title: 'Verification and Review',
      description: 'Review the completed implementation',
      type: 'review',
      contract: {
        objective: 'Review implementation against acceptance criteria',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['No blocking findings'],
        dependencies: ['TASK-IMPL'],
        completionMode: 'review',
      },
    };

    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'review',
        complexity: 'medium',
        risk: 'high',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement more changes',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review the implementation',
          },
        ],
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'Router incorrectly tried to implement inside a review task',
        source: 'static',
      },
      { task, availableAgents: ['claude', 'codex'] },
    );

    expect(guarded.strategy).toBe('single');
    expect(guarded.teamSize).toBe(1);
    expect(guarded.roles).toHaveLength(1);
    expect(guarded.roles[0].role).toBe('reviewer');
    expect(guarded.roles[0].requiredCapabilities).toEqual(['canRead']);
  });

  it('routes an architecture boundary gate as one read-only architecture reviewer', () => {
    const task: Task = {
      ...sampleTask,
      id: 'TASK-ARCH-BOUNDARY',
      title: 'Resolve State Ownership and Consistency Boundary',
      description: 'Decide state ownership before implementation',
      type: 'architecture',
      contract: {
        objective: 'Decide authoritative state owner and event invalidation boundary',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Boundary decision produced'],
        dependencies: [],
        completionMode: 'report',
        metadata: { architectureBoundaryDecision: true },
      },
    };

    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'collaborative',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Implement cache',
          },
          {
            role: 'architecture_reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Review architecture',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Overstaffed architecture decision',
        source: 'openai',
      },
      { task, availableAgents: ['claude', 'codex'] },
    );

    expect(guarded.strategy).toBe('single');
    expect(guarded.teamSize).toBe(1);
    expect(guarded.roles[0].role).toBe('architecture_reviewer');
    expect(guarded.roles[0].requiredCapabilities).toEqual(['canRead']);
  });

  it('rejects multi-agent fan-out when roles duplicate the same work without a quality guard', () => {
    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'medium',
        teamSize: 3,
        roles: [
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'Read the repository and summarize it' },
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'Read the repository and summarize it' },
          { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'Read the repository and summarize it' },
        ],
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: true,
        },
        reason: 'Use multiple agents because the task is complex',
        source: 'openai',
      },
      { task: sampleTask, availableAgents: ['claude', 'codex', 'agy'] },
    );

    expect(guarded.strategy).toBe('single');
    expect(guarded.teamSize).toBe(1);
    expect(guarded.roles).toHaveLength(1);
    expect(guarded.reason).toContain('Fan-out rejected by efficiency policy');
    expect(guarded.fanOutAssessment).toMatchObject({
      requested: true,
      admitted: false,
      requestedTeamSize: 3,
      admittedTeamSize: 1,
    });
  });

  it('rejects paraphrased duplicate objectives instead of treating wording changes as parallel work', () => {
    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'medium',
        teamSize: 2,
        roles: [
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Inspect the payment repository and find duplicate transaction behavior',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Analyze duplicate transaction behavior in the payment codebase',
          },
        ],
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: true,
        },
        reason: 'Two researchers can both investigate',
        source: 'openai',
      },
      { task: sampleTask, availableAgents: ['claude', 'codex'] },
    );

    expect(guarded.strategy).toBe('single');
    expect(guarded.fanOutAssessment?.admitted).toBe(false);
  });

  it('normalizes an invalid multi-agent team size when only one executable role exists', () => {
    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'medium',
        teamSize: 3,
        roles: [
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Investigate the repository',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason: 'Router returned inconsistent team shape',
        source: 'openai',
      },
      { task: sampleTask, availableAgents: ['claude', 'codex', 'agy'] },
    );

    expect(guarded.strategy).toBe('single');
    expect(guarded.teamSize).toBe(1);
    expect(guarded.roles).toHaveLength(1);
    expect(guarded.fanOutAssessment?.admitted).toBe(false);
  });

  it('admits resource-partitioned work even when the surrounding wording is similar', () => {
    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'collaborative',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'medium',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Create a.txt',
          },
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Create b.txt',
          },
        ],
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: true,
        },
        reason: 'Partition the output by artifact',
        source: 'openai',
      },
      { task: sampleTask, availableAgents: ['claude', 'codex'] },
    );

    expect(guarded.strategy).toBe('collaborative');
    expect(guarded.roles).toHaveLength(2);
    expect(guarded.fanOutAssessment?.admitted).toBe(true);
    expect(guarded.fanOutAssessment?.benefits).toContain('parallel_work');
  });

  it('admits high-uncertainty competitive solutions as an explicit quality strategy', () => {
    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'competitive',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 3,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Solve it your own way',
          },
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Solve it your own way',
          },
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite'],
            objective: 'Solve it your own way',
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'Uncertain approach: compare independent full solutions',
        source: 'openai',
      },
      { task: sampleTask, availableAgents: ['claude', 'codex', 'agy'] },
    );

    expect(guarded.strategy).toBe('competitive');
    expect(guarded.roles).toHaveLength(3);
    expect(guarded.fanOutAssessment?.admitted).toBe(true);
    expect(guarded.fanOutAssessment?.benefits).toContain('solution_diversity');
  });

  it('admits fan-out when objectives are genuinely partitioned for parallel work', () => {
    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'parallel',
        complexity: 'high',
        risk: 'medium',
        uncertainty: 'high',
        teamSize: 2,
        roles: [
          {
            role: 'reproduction_engineer',
            requiredCapabilities: ['canRead', 'canExecute'],
            objective: 'Reproduce the race and capture timing evidence',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Trace transaction and lock ownership through the persistence layer',
          },
        ],
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: true,
        },
        reason: 'Independent reproduction and code-path investigation can run concurrently',
        source: 'openai',
      },
      { task: sampleTask, availableAgents: ['claude', 'codex'] },
    );

    expect(guarded.strategy).toBe('parallel');
    expect(guarded.teamSize).toBe(2);
    expect(guarded.roles).toHaveLength(2);
    expect(guarded.fanOutAssessment?.admitted).toBe(true);
    expect(guarded.fanOutAssessment?.benefits).toContain('parallel_work');
  });

  it('admits implementer plus specialist reviewer as a quality-oriented fan-out', () => {
    const guarded = RouterQualityGuard.evaluate(
      {
        strategy: 'review',
        complexity: 'high',
        risk: 'high',
        uncertainty: 'medium',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite', 'canExecute'],
            objective: 'Implement the concurrency fix',
          },
          {
            role: 'architecture_reviewer',
            requiredCapabilities: ['canRead'],
            objective: 'Independently verify lock-order and failure-mode invariants',
          },
        ],
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: true,
        },
        reason: 'High-risk concurrency change requires independent review',
        source: 'openai',
      },
      { task: sampleTask, availableAgents: ['claude', 'codex'] },
    );

    expect(guarded.strategy).toBe('review');
    expect(guarded.roles).toHaveLength(2);
    expect(guarded.fanOutAssessment?.admitted).toBe(true);
    expect(guarded.fanOutAssessment?.benefits).toContain('quality_guard');
  });

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

  it('prefers current-task fit over historical fairness when no router preference exists', async () => {
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
    expect(selected[0].agent.id).toBe('claude');
    expect(selected[0].selectionReason).toContain('best task fit');
    expect(selected[0].fitScore).toBeGreaterThan(50);
  });

  it('selects Codex for implementation/reproduction work even when Claude is less used', async () => {
    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('claude', 'Claude Code'));
    registry.register(new FakeAgent('codex', 'Codex CLI'));

    const history = {
      getAgentSelectionStats(agentId: string, role: string) {
        return {
          agentId,
          roleAssignments: agentId === 'claude' ? 0 : 50,
          totalAssignments: agentId === 'claude' ? 0 : 100,
          lastAssignedAt: '2026-09-22T12:00:00.000Z',
        };
      },
    };

    const selector = new AgentSelector(registry, { selectionHistory: history });
    const selected = await selector.selectAgents([
      {
        role: 'reproduction_engineer',
        requiredCapabilities: ['canRead', 'canWrite', 'canExecute'],
        objective: 'Reproduce the failing test, implement the fix, and run the regression suite',
      },
    ]);

    expect(selected).toHaveLength(1);
    expect(selected[0].agent.id).toBe('codex');
    expect(selected[0].selectionReason).toContain('reproduction and test execution');
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

  it('never selects an agent outside the deterministic ownership allow-list', async () => {
    const registry = new AgentRegistry(false);
    registry.register(new FakeAgent('claude', 'Claude Code'));
    registry.register(new FakeAgent('codex', 'Codex CLI'));
    registry.register(new FakeAgent('agy', 'Google Antigravity'));

    const selector = new AgentSelector(registry);
    const selected = await selector.selectAgents(
      [
        {
          role: 'implementer',
          requiredCapabilities: ['canRead', 'canWrite'],
          objective: 'Implement the iOS change',
          preferredAgent: 'claude',
        },
      ],
      {
        selectionKey: '/workspace/zaira:TASK-01',
        allowedAgentIds: new Set(['codex']),
      },
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].agent.id).toBe('codex');
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
