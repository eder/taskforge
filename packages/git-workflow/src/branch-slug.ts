/**
 * Derives a short, git-safe branch slug from free-form goal text, e.g.
 * "Add commitment intelligence" -> "commitment-intelligence".
 * Dependency-free on purpose.
 */

const LEADING_VERBS = new Set([
  'add',
  'implement',
  'create',
  'build',
  'fix',
  'update',
  'refactor',
  'remove',
  'make',
  'write',
  'support',
  'introduce',
  'improve',
]);

const FILLER_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'please']);

/** Prefixes TaskForge reserves for its own ephemeral branches (see worktree cleanup). */
const RESERVED_PREFIXES = ['run-', 'task-', 'integration-'];

export interface BranchSlugOptions {
  /** Maximum slug length. Default 40. */
  maxLength?: number;
  /** Maximum number of words kept. Default 5. */
  maxWords?: number;
  /** Used when the goal yields no usable words. Default "change". */
  fallback?: string;
}

export function slugifyGoal(goal: string, options: BranchSlugOptions = {}): string {
  const { maxLength = 40, maxWords = 5, fallback = 'change' } = options;

  const words = goal
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  // Drop leading imperative verbs/fillers only when something meaningful remains.
  let start = 0;
  while (
    start < words.length - 1 &&
    (LEADING_VERBS.has(words[start]) || FILLER_WORDS.has(words[start]))
  ) {
    start++;
  }
  const meaningful = words.slice(start).filter((w, i) => i === 0 || !FILLER_WORDS.has(w));

  const kept: string[] = [];
  let length = 0;
  for (const word of meaningful.slice(0, maxWords)) {
    const next = length + (kept.length > 0 ? 1 : 0) + word.length;
    if (next > maxLength) break;
    kept.push(word);
    length = next;
  }
  // A single very long word still needs to fit.
  if (kept.length === 0 && meaningful.length > 0) kept.push(meaningful[0].slice(0, maxLength));

  let slug = kept.join('-');
  if (!slug) slug = fallback;
  if (RESERVED_PREFIXES.some((prefix) => slug.startsWith(prefix))) slug = `change-${slug}`;
  return slug;
}
