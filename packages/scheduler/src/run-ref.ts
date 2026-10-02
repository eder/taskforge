import type { RunRepository } from '@taskforge/persistence';

/**
 * Lets people name a run without copying a 16-digit id.
 *
 *   last | latest   the newest run
 *   2 | #2          the line number shown by `tf runs` (1 = newest)
 *   run-…           the full id
 *   4521 | …4521    the end (or start) of an id, when it is unique
 */
export type RunRefResult = { runId: string } | { error: string };

/** Plain numbers up to this many digits are list positions; longer ones are id fragments. */
const MAX_POSITION_DIGITS = 3;

export function resolveRunRef(runRepo: RunRepository, ref: string): RunRefResult {
  const text = (ref ?? '').trim();
  if (!text) return { error: 'No run given. Use `tf runs` to list runs.' };

  const runs = runRepo.listAll();
  if (runs.length === 0) return { error: 'No runs recorded yet.' };

  const lower = text.toLowerCase();
  if (lower === 'last' || lower === 'latest') return { runId: runs[0].id };

  const position = /^#?(\d{1,3})$/.exec(lower);
  if (position && position[1].length <= MAX_POSITION_DIGITS) {
    const index = Number(position[1]);
    if (index < 1 || index > runs.length) {
      return {
        error: `There is no run #${index}: only ${runs.length} run${runs.length === 1 ? '' : 's'} recorded. Use \`tf runs\`.`,
      };
    }
    return { runId: runs[index - 1].id };
  }

  const exact = runs.find((r) => r.id === text);
  if (exact) return { runId: exact.id };

  if (lower.length >= 4) {
    const matches = runs.filter((r) => r.id.endsWith(lower) || r.id.startsWith(lower));
    if (matches.length === 1) return { runId: matches[0].id };
    if (matches.length > 1) {
      return {
        error: `"${text}" matches ${matches.length} runs (${matches
          .slice(0, 3)
          .map((r) => r.id)
          .join(', ')}${matches.length > 3 ? ', …' : ''}). Use more of the id or the number from \`tf runs\`.`,
      };
    }
  }
  return { error: `Run ${text} not found. Use \`tf runs\` to list runs.` };
}
