/**
 * Parses a token amount written by a person: "500000", "500k", "1.5m", "1,200,000".
 * Returns undefined for anything that is not a positive whole number of tokens.
 */
export function parseTokenCount(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'number') return Number.isInteger(input) && input > 0 ? input : undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(input.replace(/[,_]/g, ''));
  if (!match) return undefined;
  const factor = match[2].toLowerCase() === 'm' ? 1_000_000 : match[2].toLowerCase() === 'k' ? 1_000 : 1;
  const value = Math.round(Number(match[1]) * factor);
  return value > 0 ? value : undefined;
}
