import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalStateDatabasePath } from './config.js';

/**
 * What a new person must know before pointing coding agents at a repository.
 * Shown by `tf setup`, once on first launch, and in the README, so it is not
 * only in SECURITY.md where few people look.
 */
export const SECURITY_NOTICE: readonly string[] = [
  'TaskForge is experimental (beta). Use it on a test repository, or inside a container or VM, until you trust it.',
  'The agents run as your user with no sandbox: they can read anything you can read (for example ~/.ssh, ~/.aws, your shell history).',
  'TaskForge never applies changes to your branch on its own: that is always your command (/apply, tf apply, /pr). Details: https://github.com/eder/taskforge/blob/main/SECURITY.md',
];

function markerPath(): string {
  return path.join(path.dirname(getGlobalStateDatabasePath()), 'security-notice-shown');
}

/** True until the notice has been shown once on this machine. */
export function shouldShowSecurityNotice(): boolean {
  try {
    return !fs.existsSync(markerPath());
  } catch {
    return true;
  }
}

export function markSecurityNoticeShown(): void {
  try {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
    fs.writeFileSync(markerPath(), `${new Date().toISOString()}\n`);
  } catch {
    // A notice that cannot be remembered is simply shown again; never an error.
  }
}
