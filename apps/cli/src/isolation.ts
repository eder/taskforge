import * as fs from 'node:fs';

/**
 * True when the process runs inside a container. Informational only: `tf doctor`
 * uses it to say whether agents can reach the user's real HOME. It is a hint,
 * not a security boundary, so a false negative merely shows the warning.
 */
export function isRunningInContainer(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = fs.existsSync,
): boolean {
  return env.TASKFORGE_ISOLATED === '1' || exists('/.dockerenv') || exists('/run/.containerenv');
}
