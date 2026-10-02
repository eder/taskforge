import { describe, it, expect } from 'vitest';
import { extractGoalClauses } from '../src/goal-clauses.js';
import { SemanticPlanner, summarizePlannerFailure } from '../src/semantic-planner.js';

// Shape of a real pasted request: a lead-in glued to item 1, bullets as details.
const PASTED = [
  'Vamos fazer essas tarefas 1. Extração de memória completa (§9.5, §9.8, §9.9)',
  '● Hoje a extração é determinística e cobre só compromissos.',
  '● Falta o fallback conservador com LLM para conversa não estruturada.',
  '● Falta decidir se os campos de ciclo de vida são necessários.',
  '2. Recuperação completa (§9.7–9.8)',
  '● A consulta atual em memories filtra só por tipo.',
  '● Faltam filtros por pessoa, projeto e tópico.',
  '3. Commitment Intelligence completo (§25)',
  '● Falta um endpoint no servidor que agregue todos os compromissos.',
  '4. Adapter de WhatsApp (§14)',
  '● Não foi começado. Precisa de um desenho antes.',
].join('\n');

describe('extractGoalClauses', () => {
  it('turns a numbered list with bullet details into one requirement per number', () => {
    const clauses = extractGoalClauses(PASTED);
    expect(clauses).toHaveLength(4);
    expect(clauses[0]).toMatch(/^Extração de memória completa/);
    expect(clauses[0]).toContain('fallback conservador com LLM'); // details kept with their requirement
    expect(clauses[1]).toMatch(/^Recuperação completa/);
    expect(clauses[3]).toMatch(/^Adapter de WhatsApp/);
    expect(clauses.join('\n')).not.toContain('Vamos fazer essas tarefas');
  });

  it('keeps the old behaviour for a plain list without numbers, and strips every bullet character', () => {
    expect(extractGoalClauses('- add retry\n● add logging\n• add metrics')).toEqual([
      'add retry',
      'add logging',
      'add metrics',
    ]);
  });

  it('does not treat a single numbered line as a list', () => {
    expect(extractGoalClauses('Fix 1. the bug')).toEqual(['1. the bug']);
  });
});

describe('fallback plan from a pasted list', () => {
  it('plans 4 tasks, not 13', () => {
    const planner = new SemanticPlanner({ apiKey: undefined });
    const raw = planner.tryDecomposeComplexGoal({
      id: 'g',
      description: PASTED,
      repository: '/r',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    });
    expect(raw?.tasks).toHaveLength(4);
  });
});

describe('summarizePlannerFailure', () => {
  it('explains a timeout in words instead of "This operation was aborted"', () => {
    const text = summarizePlannerFailure(['This operation was aborted']) ?? '';
    expect(text).toContain('did not answer in time');
    expect(text).toContain('router.timeoutSeconds');
  });
});
