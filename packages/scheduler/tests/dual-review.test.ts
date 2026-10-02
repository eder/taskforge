import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '@taskforge/shared';
import type { Task } from '@taskforge/core';
import { AgentRegistry } from '@taskforge/agents';
import {
  assessTaskSensitivity,
  parseReviewVerdict,
  selectIndependentReviewer,
  taskProducesChanges,
} from '../src/dual-review.js';

function makeTask(overrides: Partial<Task> = {}, contract: Partial<Task['contract']> = {}): Task {
  return {
    id: 'TASK-1',
    goalId: 'goal',
    title: 'Update the settings page',
    description: '',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Tweak a label',
      allowedScope: ['src/ui/**'],
      forbiddenChanges: [],
      acceptanceCriteria: [],
      dependencies: [],
      ...contract,
    },
    acceptanceCriteria: [],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function enabledConfig(patch: Record<string, unknown> = {}) {
  const config = getDefaultConfig();
  config.verification.dualReview = { ...config.verification.dualReview, enabled: true, ...patch };
  return config;
}

describe('assessTaskSensitivity', () => {
  it('is never sensitive while dual review is disabled (default)', () => {
    const task = makeTask({ title: 'Rotate payment credentials' });
    expect(assessTaskSensitivity(task, getDefaultConfig()).sensitive).toBe(false);
  });

  it('flags tasks whose scope matches a configured sensitive scope', () => {
    const config = enabledConfig({ scopes: ['db/migrations/**'] });
    const task = makeTask({}, { allowedScope: ['db/migrations/**'] });
    const result = assessTaskSensitivity(task, config);
    expect(result.sensitive).toBe(true);
    expect(result.reasons[0]).toContain('db/migrations');
  });

  it('flags tasks mentioning sensitive keywords, and respects word starts', () => {
    const config = enabledConfig();
    expect(assessTaskSensitivity(makeTask({ title: 'Add password reset flow' }), config).sensitive).toBe(true);
    expect(
      assessTaskSensitivity(makeTask({}, { objective: 'Run the database migration safely' }), config)
        .sensitive,
    ).toBe(true);
    expect(assessTaskSensitivity(makeTask({ title: 'Fix typo in README' }), config).sensitive).toBe(false);
  });

  it('honors the explicit sensitive metadata flag', () => {
    const task = makeTask({}, { metadata: { sensitive: true } });
    expect(assessTaskSensitivity(task, enabledConfig({ keywords: [] })).sensitive).toBe(true);
  });
});

describe('taskProducesChanges', () => {
  it('is false for read-only report and review tasks', () => {
    expect(taskProducesChanges(makeTask({}, { forbiddenChanges: ['*'] }))).toBe(false);
    expect(taskProducesChanges(makeTask({}, { completionMode: 'report' }))).toBe(false);
    expect(taskProducesChanges(makeTask({}, { completionMode: 'review' }))).toBe(false);
    expect(taskProducesChanges(makeTask({}, { completionMode: 'mutation' }))).toBe(true);
  });
});

describe('parseReviewVerdict', () => {
  it('approves only on a single APPROVED verdict line', () => {
    const parsed = parseReviewVerdict('Looks safe.\nREVIEW_VERDICT: APPROVED\n');
    expect(parsed.verdict).toBe('approved');
    expect(parsed.findings).toBe('Looks safe.');
  });

  it('rejects on REJECTED and keeps the findings as evidence', () => {
    const parsed = parseReviewVerdict('- auth.ts: token never expires\nREVIEW_VERDICT: REJECTED');
    expect(parsed.verdict).toBe('rejected');
    expect(parsed.findings).toContain('token never expires');
  });

  it('fails closed: missing verdict, and conflicting verdicts', () => {
    expect(parseReviewVerdict('All good!').verdict).toBe('missing');
    expect(parseReviewVerdict(undefined).verdict).toBe('missing');
    expect(parseReviewVerdict('REVIEW_VERDICT: APPROVED\nREVIEW_VERDICT: REJECTED').verdict).toBe('rejected');
  });

  it('ignores a verdict that is only quoted inside prose', () => {
    expect(parseReviewVerdict('I would write REVIEW_VERDICT: APPROVED if fixed').verdict).toBe('missing');
  });
});

describe('selectIndependentReviewer', () => {
  it('never selects an excluded (implementing) agent', async () => {
    const registry = new AgentRegistry(false);
    const stub = (id: string) =>
      ({
        id,
        name: id,
        detect: async () => true,
        capabilities: async () => ({ canRead: true, canWrite: true, canExecute: true, languages: [], tools: [] }),
        execute: async () => ({ success: true, message: '', durationMs: 0 }),
      }) as never;
    registry.register(stub('claude'));
    registry.register(stub('codex'));

    const reviewer = await selectIndependentReviewer(registry.list(), new Set(['claude']), 'review auth change');
    expect(reviewer?.id).toBe('codex');

    const none = await selectIndependentReviewer(registry.list(), new Set(['claude', 'codex']), 'review');
    expect(none).toBeUndefined();
  });
});
