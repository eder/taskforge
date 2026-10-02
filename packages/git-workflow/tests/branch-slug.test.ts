import { describe, it, expect } from 'vitest';
import { slugifyGoal } from '../src/branch-slug.js';

describe('slugifyGoal', () => {
  it('drops the leading verb and slugifies the rest', () => {
    expect(slugifyGoal('Add commitment intelligence')).toBe('commitment-intelligence');
  });

  it('strips accents and punctuation', () => {
    expect(slugifyGoal('Corrigir validação do e-mail!!')).toBe('corrigir-validacao-do-e-mail');
  });

  it('keeps the verb when nothing else remains', () => {
    expect(slugifyGoal('fix')).toBe('fix');
  });

  it('limits words and length', () => {
    const slug = slugifyGoal('implement the retry budget handling for payment webhooks in checkout');
    expect(slug.split('-').length).toBeLessThanOrEqual(5);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('retry-budget-handling-payment-webhooks');
  });

  it('falls back when the goal has no usable characters', () => {
    expect(slugifyGoal('!!! ???')).toBe('change');
    expect(slugifyGoal('')).toBe('change');
  });

  it('never collides with TaskForge reserved ephemeral prefixes', () => {
    expect(slugifyGoal('run 123 again')).toBe('change-run-123-again');
    expect(slugifyGoal('task-01 cleanup').startsWith('task-')).toBe(false);
  });

  it('produces only git-safe characters', () => {
    expect(slugifyGoal('Support C++/Rust "interop" (v2)')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
