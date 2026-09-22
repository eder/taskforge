import { describe, expect, it } from 'vitest';
import { theme } from '../src/theme.js';

describe('TaskForge theme agent status', () => {
  it('shows an absolute reset time instead of a frozen relative quota reason', () => {
    const resetAt = new Date(Date.now() + 90 * 60 * 1000);
    const rendered = theme.agentPill(
      'agy',
      'Google Antigravity',
      false,
      'quota_exhausted',
      'resets in 32h30m34s',
      resetAt,
    );

    expect(rendered).toContain('quota exhausted');
    expect(rendered).toContain('resets at');
    expect(rendered).not.toContain('32h30m34s');
  });
});
