import { describe, it, expect } from 'vitest';
import {
  detectExecutionIntent,
  isLightweightReadOnlyRequest,
} from '../src/execution-intent.js';

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

  it('does not treat a real bug investigation as a lightweight summary', () => {
    expect(
      isLightweightReadOnlyRequest('Investigate the flaky scheduler deadlock and find the root cause'),
    ).toBe(false);
  });

  it('classifies natural Portuguese project-overview question variants as lightweight read-only', () => {
    for (const request of [
      'O que é esse projeto?',
      'O que é este repositório?',
      'Para que serve esse projeto?',
      'Como esse projeto funciona?',
      'Qual é o objetivo desse sistema?',
    ]) {
      expect(isLightweightReadOnlyRequest(request)).toBe(true);
      const decision = detectExecutionIntent(request);
      expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
      expect(decision.mutationAllowed).toBe(false);
      expect(decision.deliveryAllowed).toBe(false);
      expect(decision.forbiddenChanges).toEqual(['*']);
    }
  });

  it('classifies natural English project-overview question variants as lightweight read-only', () => {
    for (const request of [
      'What is this project?',
      'What does this repository do?',
      'How does this application work?',
      'What is this codebase for?',
    ]) {
      expect(isLightweightReadOnlyRequest(request)).toBe(true);
      expect(detectExecutionIntent(request).intent).toBe('READ_ONLY_ANALYSIS');
    }
  });

  it('classifies "O que esse projeto faz?" as lightweight read-only analysis', () => {
    expect(isLightweightReadOnlyRequest('O que esse projeto faz?')).toBe(true);

    const decision = detectExecutionIntent('O que esse projeto faz?');
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
    expect(decision.deliveryAllowed).toBe(false);
    expect(decision.forbiddenChanges).toEqual(['*']);
  });

  it('does not hide an explicit mutation request behind a project-overview question', () => {
    const request = 'O que esse projeto faz? Depois atualize o README com essa explicação.';
    expect(isLightweightReadOnlyRequest(request)).toBe(false);
    expect(detectExecutionIntent(request).intent).toBe('IMPLEMENTATION');
  });

  it('classifies a Portuguese repository summary request as READ_ONLY_ANALYSIS', () => {
    const decision = detectExecutionIntent('Resuma esse projeto para mim');
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
    expect(decision.deliveryAllowed).toBe(false);
    expect(decision.forbiddenChanges).toEqual(['*']);
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

  it('does not promote architectural outcome wording into forbidden changes', () => {
    const decision = detectExecutionIntent([
      'Create a pluggable LLM provider architecture for TaskForge.',
      'Do not implement this format blindly; inspect the existing code first.',
      'Support an OpenAI-compatible provider without creating a hardcoded integration for every company.',
      'The final architecture should allow changing providers without altering SemanticPlanner, Router, or the rest of the control plane.',
    ].join('\n'));

    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.mutationAllowed).toBe(true);
    expect(decision.forbiddenChanges).toEqual([]);
  });

  it('does not turn Portuguese architectural outcome language into repository constraints', () => {
    const decision = detectExecutionIntent([
      'Implemente suporte a múltiplos providers.',
      'Não implemente esse formato cegamente.',
      'Permita adicionar providers sem criar uma integração hardcoded.',
      'O resultado deve funcionar sem alterar o SemanticPlanner ou Router para cada novo provider.',
    ].join('\n'));

    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.forbiddenChanges).toEqual([]);
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
