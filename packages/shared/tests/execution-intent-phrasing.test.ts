import { describe, it, expect } from 'vitest';
import { detectExecutionIntent } from '../src/execution-intent.js';

const intent = (text: string) => detectExecutionIntent(text).intent;

describe('natural read-only requests are not treated as implementation', () => {
  // The exact request that cost 661k tokens and 7 minutes as an "implementation" plan.
  it.each([
    'veja o que falta ser feito nesse projeto',
    'Veja o que falta ser feito',
    'o que ainda falta fazer no projeto?',
    'o que falta implementar?',
    'quais são as pendências do projeto',
    'liste os próximos passos',
    'mostre o estado atual do projeto',
    'confira se os testes cobrem o módulo de memória',
    'verifique o que está pendente',
    'levante os riscos da arquitetura atual',
    "what's left to do in this project",
    'show me how the scheduler works',
    'list the open TODOs',
    'check what is missing in the docs',
  ])('"%s" is READ_ONLY_ANALYSIS', (text) => {
    const decision = detectExecutionIntent(text);
    expect(decision.intent).toBe('READ_ONLY_ANALYSIS');
    expect(decision.mutationAllowed).toBe(false);
    expect(decision.deliveryAllowed).toBe(false);
  });
});

describe('a read-style verb never hides a real change request', () => {
  it.each([
    'veja o bug no login e corrija',
    'verifique o README e atualize a seção de instalação',
    'confira o schema e altere o tipo SEMANTIC_MEMORY',
    'liste os arquivos e crie um relatório',
    'mostre o diff e aplique',
    'verifique e faça o deploy',
    'revise o código e ajuste os nomes',
    'confira o config e troque o modelo para gpt-4o',
    'check the tests and fix the failing one',
    'list the endpoints and add a health check',
    'show me the diff and merge it',
    'inspect the schema and rename the column',
    'look at the retry logic and refactor it',
  ])('"%s" stays IMPLEMENTATION', (text) => {
    const decision = detectExecutionIntent(text);
    expect(decision.intent).toBe('IMPLEMENTATION');
    expect(decision.mutationAllowed).toBe(true);
  });

  it('an explicit prohibition still wins over any verb', () => {
    expect(intent('veja o que falta e corrija, mas não altere nenhum arquivo')).toBe('READ_ONLY_ANALYSIS');
  });
});
