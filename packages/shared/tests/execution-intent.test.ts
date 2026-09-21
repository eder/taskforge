import { describe, it, expect } from 'vitest';
import { detectExecutionIntent } from '../src/execution-intent.js';

describe('detectExecutionIntent', () => {
  it('classifies "analysis only" as READ_ONLY_ANALYSIS', () => {
    const decision = detectExecutionIntent(
      'Evaluate whether the OpenAI Agents SDK makes sense here. Analysis only.',
    );
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
    expect(decision.deliveryAllowed).toBe(false);
    expect(decision.forbiddenChanges).toEqual(['*']);
  });

  it('keeps a scoped negative directive read-only when there is no affirmative mutation request', () => {
    const decision = detectExecutionIntent(
      'DO NOT update documentation. Evaluate whether documentation needs changes.',
    );
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
  });

  it('"não altere nenhum arquivo" wins over the word "atualize" appearing elsewhere', () => {
    const decision = detectExecutionIntent(
      'Não altere nenhum arquivo. Apenas diga se o README deveria ser atualizado.',
    );
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
  });

  it('"do not create files" is not read as create intent', () => {
    const decision = detectExecutionIntent('Do not create files. Just tell me what you would do.');
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
  });

  it('falls back to READ_ONLY_ANALYSIS for a plain explanation request with no action verb', () => {
    const decision = detectExecutionIntent('Please explain how the scheduler assigns agents to tasks.');
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
  });

  it('classifies a plain-language Portuguese analysis request as READ_ONLY_ANALYSIS', () => {
    const decision = detectExecutionIntent('Avalie a arquitetura atual e me diga sua opinião técnica.');
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
  });

  it('treats an explicit "update the README" request as implementation', () => {
    const decision = detectExecutionIntent('Update the README to document the new health endpoint.');
    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.mutationAllowed).toBe(true);
    expect(decision.deliveryAllowed).toBe(true);
  });

  it('treats a normal fix/implement request as implementation', () => {
    const decision = detectExecutionIntent('Fix the runtime agent failover bug in the scheduler.');
    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.mutationAllowed).toBe(true);
  });

  it('keeps implementation intent when a scoped English no-modification constraint is present', () => {
    const decision = detectExecutionIntent(
      'Implement /health and add tests. Do not modify the Delivery Gate.',
    );

    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.mutationAllowed).toBe(true);
    expect(decision.deliveryAllowed).toBe(true);
    expect(decision.forbiddenChanges).toEqual(['Delivery Gate']);
  });

  it('keeps implementation intent when a scoped Portuguese no-modification constraint is present', () => {
    const decision = detectExecutionIntent(
      'Corrija o scheduler mas não modifique o schema do banco.',
    );

    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.mutationAllowed).toBe(true);
    expect(decision.forbiddenChanges).toEqual(['schema do banco']);
  });

  it('keeps implementation intent with a concrete file restriction', () => {
    const decision = detectExecutionIntent(
      "Fix the scheduler. Don't change package.json.",
    );

    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.forbiddenChanges).toEqual(['package.json']);
  });

  it('global no-mutation directive remains authoritative even with an implementation verb elsewhere', () => {
    const decision = detectExecutionIntent(
      'Implement the feature conceptually, but do not modify anything in the repository.',
    );

    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
    expect(decision.forbiddenChanges).toEqual(['*']);
  });

  it('never allows delivery for a READ_ONLY_ANALYSIS decision', () => {
    const decision = detectExecutionIntent('read only evaluation of the current design');
    expect(decision.deliveryAllowed).toBe(false);
  });
});
