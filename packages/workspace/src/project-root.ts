import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * TaskForge keeps its state (database, runs, worktrees) and its optional
 * config in `<project>/.taskforge/`, with every path relative to the working
 * directory. Run from a sub-folder (`zaira/server`), it would silently use a
 * brand-new, empty `server/.taskforge/`: no runs, no config, and a stray
 * directory inside the repository.
 *
 * The project root is therefore resolved first:
 *   1. TASKFORGE_PROJECT_ROOT, when set to an existing directory;
 *   2. the nearest enclosing git repository (a `.git` directory or file);
 *   3. otherwise the nearest ancestor that already has a `.taskforge/`
 *      (never the user's home, where `~/.taskforge` is the *global* config);
 *   4. otherwise the starting directory itself.
 */
export function findProjectRoot(
  start: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.TASKFORGE_PROJECT_ROOT?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (isDirectory(resolved)) return resolved;
  }

  const origin = path.resolve(start);
  const ancestors: string[] = [];
  for (let dir = origin; ; dir = path.dirname(dir)) {
    ancestors.push(dir);
    if (path.dirname(dir) === dir) break;
  }

  const git = ancestors.find((dir) => fs.existsSync(path.join(dir, '.git')));
  if (git) return git;

  const home = path.resolve(os.homedir());
  const withState = ancestors.find(
    (dir) => dir !== home && isDirectory(path.join(dir, '.taskforge')),
  );
  return withState ?? origin;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
