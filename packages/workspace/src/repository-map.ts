import * as path from 'node:path';

/** Lines of the map the planner receives: roughly 1,000 tokens, whatever the repository size. */
const MAX_MAP_LINES = 40;
/** Directories are expanded no deeper than this. */
const MAX_DEPTH = 4;

interface DirectoryStats {
  files: number;
  extensions: Map<string, number>;
}

/**
 * A short outline of where the code lives, for planning: tracked files are
 * grouped by directory and the biggest directories are expanded first until the
 * line budget is used. A planner that sees `packages/storage/` and
 * `packages/http/` can give parallel tasks scopes that do not overlap; one that
 * sees only "TypeScript, pnpm" has to guess, and a wrong guess serializes them.
 *
 * Pure: takes the list of repository-relative paths (`git ls-files`).
 */
export function buildRepositoryMap(files: string[]): string[] {
  if (files.length === 0) return [];
  const stats = new Map<string, DirectoryStats>();
  const children = new Map<string, Set<string>>();

  for (const file of files) {
    const parts = file.split('/');
    // The directory chain of the file, from the root down.
    for (let depth = 0; depth < Math.min(parts.length, MAX_DEPTH + 1); depth++) {
      const dir = parts.slice(0, depth).join('/');
      const entry = stats.get(dir) ?? { files: 0, extensions: new Map() };
      entry.files += 1;
      const ext = path.extname(file).replace('.', '') || 'other';
      entry.extensions.set(ext, (entry.extensions.get(ext) ?? 0) + 1);
      stats.set(dir, entry);
      if (depth < parts.length - 1 && depth < MAX_DEPTH) {
        const child = parts.slice(0, depth + 1).join('/');
        const set = children.get(dir) ?? new Set();
        set.add(child);
        children.set(dir, set);
      }
    }
  }

  // Start from the top-level directories and keep opening the largest shown one.
  const topLevel = [...(children.get('') ?? [])].sort(
    (a, b) => stats.get(b)!.files - stats.get(a)!.files,
  );
  const hidden = Math.max(0, topLevel.length - MAX_MAP_LINES);
  const shown = new Set<string>(topLevel.slice(0, MAX_MAP_LINES));
  const expandable = (dir: string) => (children.get(dir)?.size ?? 0) > 0;
  const directFiles = (dir: string) =>
    stats.get(dir)!.files -
    [...(children.get(dir) ?? [])].reduce((n, child) => n + stats.get(child)!.files, 0);
  // A directory that was opened still has its own files; they keep one line so they do not vanish.
  const owned = new Map<string, number>();
  while (shown.size + owned.size < MAX_MAP_LINES) {
    const next = [...shown]
      .filter(expandable)
      .sort((a, b) => stats.get(b)!.files - stats.get(a)!.files)[0];
    const opened = next ? (children.get(next) as Set<string>) : undefined;
    if (!next || !opened) break;
    const own = directFiles(next);
    // Opening replaces the directory by its children (and one line for its own files).
    if (shown.size + owned.size - 1 + opened.size + (own > 0 ? 1 : 0) > MAX_MAP_LINES) break;
    shown.delete(next);
    for (const child of opened) shown.add(child);
    if (own > 0) owned.set(next, own);
  }

  const entries = [...shown].map((dir) => {
    const entry = stats.get(dir)!;
    const top = [...entry.extensions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ext, count]) => `${ext} ${count}`)
      .join(', ');
    return { key: `${dir}/`, text: `${dir}/ — ${entry.files} files (${top})` };
  });
  for (const [dir, count] of owned) {
    entries.push({ key: `${dir}/`, text: `${dir}/ — ${count} files directly in it` });
  }
  const lines = entries.sort((a, b) => a.key.localeCompare(b.key)).map((entry) => entry.text);
  const rootFiles = directFiles('');
  if (rootFiles > 0) lines.unshift(`(repository root) — ${rootFiles} files`);
  if (hidden > 0) lines.push(`… and ${hidden} smaller top-level directories`);
  return lines;
}
