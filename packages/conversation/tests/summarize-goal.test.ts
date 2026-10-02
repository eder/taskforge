import { describe, it, expect } from 'vitest';
import { summarizeGoal } from '../src/shell-helpers.js';

describe('summarizeGoal', () => {
  it('leaves a short single-line goal untouched', () => {
    expect(summarizeGoal('Add a greeting helper')).toBe('Add a greeting helper');
  });

  it('keeps only the first non-empty line of a long prompt and marks the rest', () => {
    const prompt = '\n\nQuero que você faça uma AVALIAÇÃO TÉCNICA\n\nESTA TAREFA É EXCLUSIVAMENTE DE ANÁLISE.\n\nNÃO implemente nada.';
    expect(summarizeGoal(prompt)).toBe('Quero que você faça uma AVALIAÇÃO TÉCNICA …');
  });

  it('cuts a very long single line at a word boundary', () => {
    const long = 'word '.repeat(80).trim();
    const out = summarizeGoal(long, 40);
    expect(out.endsWith(' …')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(42);
    expect(out).not.toMatch(/wor …$/); // never cuts a word in half
  });

  it('collapses internal whitespace and handles empty input', () => {
    expect(summarizeGoal('a    b\t c')).toBe('a b c');
    expect(summarizeGoal('')).toBe('');
    expect(summarizeGoal('   \n  ')).toBe('');
  });
});
