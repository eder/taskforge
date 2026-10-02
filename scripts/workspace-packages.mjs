import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Returns every publishable workspace package (packages/* and apps/*). */
export function listWorkspacePackages() {
  const result = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const file = join(groupDir, entry, 'package.json');
      if (!existsSync(file)) continue;
      result.push({ dir: join(group, entry), file, json: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  return result;
}
