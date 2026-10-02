import { describe, it, expect } from 'vitest';
import type { Task } from '@taskforge/core';
import {
  StaticRoutingProvider,
  RouterQualityGuard,
  taskRequiresMutation,
  type RoutingDecision,
} from '../src/index.js';

function task(overrides: Partial<Task> = {}, contract: Partial<Task['contract']> = {}): Task {
  return {
    id: 'T2',
    goalId: 'g',
    title: 'Atualizar docs/project-state.md para refletir o estado real do projeto',
    description:
      'Com base na investigação da T1 e no trace do commit, reescrever o documento. Autor: equipe.',
    type: 'implementation',
    status: 'accepted',
    dependencies: ['T1'],
    contract: {
      objective: 'Atualizar docs/project-state.md',
      allowedScope: ['docs/**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['documento atualizado'],
      dependencies: ['T1'],
      completionMode: 'mutation',
      ...contract,
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('taskRequiresMutation', () => {
  it('follows the completion mode, then the task type for legacy contracts', () => {
    expect(taskRequiresMutation(task())).toBe(true);
    expect(taskRequiresMutation(task({}, { completionMode: 'report' }))).toBe(false);
    expect(taskRequiresMutation(task({}, { completionMode: 'verification' }))).toBe(false);
    expect(taskRequiresMutation(task({}, { forbiddenChanges: ['*'] }))).toBe(false);
    expect(taskRequiresMutation(task({ type: 'refactoring' }, { completionMode: undefined }))).toBe(true);
    expect(taskRequiresMutation(task({ type: 'investigation' }, { completionMode: undefined }))).toBe(false);
  });
});

describe('static router never drops the implementer of a mutating task', () => {
  const router = new StaticRoutingProvider();

  it('an implementation task that merely mentions "investigação" is not routed as an investigation', async () => {
    const decision = await router.route({ task: task(), availableAgents: ['claude', 'codex', 'agy'] });
    expect(decision.roles.some((r) => r.role === 'implementer')).toBe(true);
    expect(decision.roles.map((r) => r.role)).not.toContain('reproduction_engineer');
  });

  it('matches keywords as whole words ("trace" is not "race", "author" is not "auth")', async () => {
    const decision = await router.route({
      task: task({ title: 'Update the author trace in the README', description: 'trace author debug' }),
      availableAgents: ['claude'],
    });
    expect(decision.strategy).toBe('single');
    expect(decision.risk).toBe('low');
  });

  it('still routes genuine read-only investigations to the parallel investigation team', async () => {
    const decision = await router.route({
      task: task(
        { type: 'investigation', title: 'Investigate flaky test' },
        { completionMode: 'report', forbiddenChanges: ['*'] },
      ),
      availableAgents: ['claude', 'codex', 'agy'],
    });
    expect(decision.strategy).toBe('parallel');
    expect(decision.roles.some((r) => r.role === 'implementer')).toBe(false);
  });
});

describe('RouterQualityGuard adds a missing implementer for any provider', () => {
  const noImplementer: RoutingDecision = {
    strategy: 'parallel',
    complexity: 'high',
    risk: 'medium',
    uncertainty: 'high',
    teamSize: 2,
    roles: [
      { role: 'researcher', requiredCapabilities: ['canRead'], objective: 'research' },
      { role: 'architecture_reviewer', requiredCapabilities: ['canRead'], objective: 'review' },
    ],
    communication: { required: true, initialAlignment: true, synthesisBeforeImplementation: true },
    reason: 'model decision',
    source: 'openai',
  };

  it('prepends an implementer for a mutating task and keeps the support roles', () => {
    const result = RouterQualityGuard.evaluate(noImplementer, { task: task(), availableAgents: ['claude'] });
    expect(result.roles[0].role).toBe('implementer');
    expect(result.roles[0].objective).toBe('Atualizar docs/project-state.md');
    expect(result.roles.map((r) => r.role)).toEqual(['implementer', 'researcher', 'architecture_reviewer']);
    expect(result.teamSize).toBe(3);
    expect(result.reason).toContain('implementer role was added');
  });

  it('leaves read-only tasks and decisions that already have an implementer unchanged', () => {
    const readOnly = task({ type: 'investigation' }, { completionMode: 'report', forbiddenChanges: ['*'] });
    const a = RouterQualityGuard.evaluate(noImplementer, { task: readOnly, availableAgents: ['claude'] });
    expect(a.roles.some((r) => r.role === 'implementer')).toBe(false);

    const withImpl: RoutingDecision = {
      ...noImplementer,
      roles: [{ role: 'implementer', requiredCapabilities: ['canWrite'], objective: 'x' }, ...noImplementer.roles],
      teamSize: 3,
    };
    const b = RouterQualityGuard.evaluate(withImpl, { task: task(), availableAgents: ['claude'] });
    expect(b.roles.filter((r) => r.role === 'implementer')).toHaveLength(1);
  });
});
