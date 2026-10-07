/**
 * Whether an agent CLI is signed in, learned from the CLI's own status command (no model call, no tokens).
 * `unknown` is the honest answer when the CLI has no such command or its output is not understood:
 * only an explicit "signed out" may take an agent out of use.
 */
export type AuthState = 'signed_in' | 'signed_out' | 'unknown';

export interface AuthStatus {
  state: AuthState;
  detail?: string;
  /** What the user runs to sign in again (shown when signed out). */
  signInCommand?: string;
}

/** `claude auth status` prints JSON with `loggedIn`. */
export function parseClaudeAuthStatus(stdout: string): AuthStatus {
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    if (status.loggedIn === true) {
      return {
        state: 'signed_in',
        detail: typeof status.authMethod === 'string' ? status.authMethod : undefined,
      };
    }
    if (status.loggedIn === false)
      return { state: 'signed_out', signInCommand: 'claude auth login' };
  } catch {
    // not JSON: unknown
  }
  return { state: 'unknown' };
}

/** `codex login status` prints e.g. "Logged in using ChatGPT"; a signed-out CLI says it is not logged in. */
export function parseCodexLoginStatus(stdout: string, exitCode: number): AuthStatus {
  const text = stdout.trim();
  if (/not logged in/i.test(text)) return { state: 'signed_out', signInCommand: 'codex login' };
  if (exitCode === 0 && /logged in/i.test(text)) return { state: 'signed_in', detail: text };
  return { state: 'unknown' };
}
