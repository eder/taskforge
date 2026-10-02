/**
 * Splits a pasted goal into the requirements it lists, for the fallback plan
 * used when the planning model does not answer.
 *
 * A numbered list is a list of requirements: "1. Memory extraction" followed by
 * bullets describing it is ONE requirement with details, not a dozen. Without
 * numbers, each non-empty line is a requirement (the original behaviour).
 * Text before the first number ("Let's do these tasks 1. ...") is a lead-in,
 * not a requirement.
 */
const BULLET = /^[\s\-*•●○◦▪▫‣·>]+/;
const NUMBERED = /^\d{1,2}[.)]\s+(.+)$/;

export function extractGoalClauses(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(BULLET, '').trim())
    .filter((l) => l.length > 0);

  // "Lead-in text 1. First item" on one line: split the lead-in off.
  if (lines.length > 0) {
    const inline = /^(.*?\S)\s+(1[.)])\s+(\S.*)$/.exec(lines[0]);
    if (inline && !NUMBERED.test(lines[0])) lines[0] = `${inline[2]} ${inline[3]}`;
  }

  const headerCount = lines.filter((l) => NUMBERED.test(l)).length;
  if (headerCount < 2) return lines;

  const clauses: string[] = [];
  let current: { title: string; details: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    clauses.push(current.details.length > 0 ? `${current.title}: ${current.details.join('; ')}` : current.title);
  };
  for (const line of lines) {
    const header = NUMBERED.exec(line);
    if (header) {
      flush();
      current = { title: header[1].trim(), details: [] };
    } else if (current) {
      current.details.push(line);
    }
    // Lines before the first numbered item are lead-in text and are dropped.
  }
  flush();
  return clauses;
}
