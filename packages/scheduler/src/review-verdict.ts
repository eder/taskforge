import { parseReviewVerdict } from './dual-review.js';

/**
 * Reviewers are asked to end with a verdict line (the same `REVIEW_VERDICT:`
 * protocol the dual-review gate uses) so their findings are acted on instead of
 * read. Free text such as "I wouldn't call it accepted yet" cannot be evaluated
 * by code; a verdict plus a list can.
 */
// The verdict lines appear only inside sentences, never alone on a line, so an agent
// that repeats this text back cannot be mistaken for one that issued a verdict.
export const REVIEW_CONTRACT = [
  '',
  'Reply format (required): the last line of your reply must be exactly `REVIEW_VERDICT: APPROVED` when the change can be accepted as it is, or exactly `REVIEW_VERDICT: REJECTED` when something must change first.',
  'When you reject, list every required change on its own line starting with "- ".',
  'Reject only for real problems in the change itself (bugs, broken contracts, missing tests for new behaviour), not for style or optional ideas.',
].join('\n');

export function isReviewerRole(role: string): boolean {
  return /review/i.test(role);
}

const LIST_ITEM = /^\s*(?:[-*•●]|\d{1,2}[.)])\s+(\S.*)$/;

/**
 * Whether a reviewer asked for changes, and what they listed. A reply with no
 * verdict line (or an approval) asks for nothing: behaviour is unchanged for
 * reviewers that ignore the format.
 */
export function reviewChangesFrom(output?: string): { rejected: boolean; changes: string[] } {
  const parsed = parseReviewVerdict(output);
  if (parsed.verdict !== 'rejected') return { rejected: false, changes: [] };
  const changes = parsed.findings
    .split('\n')
    .map((line) => LIST_ITEM.exec(line)?.[1]?.trim())
    .filter((item): item is string => Boolean(item))
    .map((item) => item.slice(0, 400))
    .slice(0, 12);
  return {
    rejected: true,
    changes: changes.length > 0 ? changes : [parsed.findings.slice(0, 600)].filter(Boolean),
  };
}

/** The instruction given back to the implementer for the fix pass. */
export function reviewFixObjective(taskObjective: string, changes: string[]): string {
  return [
    `An independent reviewer found problems in your change for: ${taskObjective}`,
    'Fix every one of them in the code you already wrote, run the relevant tests, and commit. Do not start unrelated work.',
    'Required changes:',
    ...changes.map((c) => `- ${c}`),
  ].join('\n');
}
