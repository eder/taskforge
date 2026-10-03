import {
  AgentCapabilities,
  AgentContext,
} from '@taskforge/shared';

import { BaseCliAdapter, CliAdapterOptions } from './base-cli-adapter.js';

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly binaryName = 'claude';
  readonly stdinMode = 'interactive';
  readonly permissionProtocol = 'structured';

  protected providerEnvAllow(): string[] {
    return ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  }

  constructor(options: CliAdapterOptions = {}) {
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        // TaskForge never resumes a provider session, so do not leave one on disk per
        // assignment (hundreds of stray sessions pile up in ~/.claude/projects otherwise).
        : ['--output-format=stream-json', '--verbose', '--no-session-persistence', '-p'];
    super({
      ...options,
      defaultArgs,
    });
  }

  /**
   * In headless mode Claude Code does not edit files unless told it may: a write is "denied
   * because write permission hasn't been granted" and the run ends with no changes (seen on a
   * fresh project; a project the user had already set up by hand worked). TaskForge states what
   * each assignment may do instead of depending on the user's settings: edits are accepted
   * (inside the isolated worktree) when it may change files. Other tools, including shell
   * commands, stay under the normal permission checks. Read-only assignments are left as they
   * are, and any permission flag the user put in the agent's `defaultArgs` is respected.
   */
  protected formatArgs(prompt: string, context?: AgentContext): string[] {
    const args = super.formatArgs(prompt, context);
    const chosenByUser = (this.options.defaultArgs ?? []).some(
      (a) =>
        a.startsWith('--permission-mode') ||
        a.startsWith('--allowedTools') ||
        a.startsWith('--allowed-tools') ||
        a.includes('skip-permissions'),
    );
    if (chosenByUser || !context) return args;
    const readOnly = context.mutationAllowed === false || context.task.forbiddenChanges.includes('*');
    if (readOnly) return args;
    // The prompt follows `-p`, so the flags go before it.
    const at = args.indexOf('-p');
    const insertAt = at >= 0 ? at : args.length - 1;
    return [...args.slice(0, insertAt), '--permission-mode', 'acceptEdits', ...args.slice(insertAt)];
  }

  async capabilities(): Promise<AgentCapabilities> {
    const base = await super.capabilities();
    return {
      ...base,
      stdinMode: 'interactive',
      permissionProtocol: 'structured',
      questionProtocol: 'structured',
    };
  }
}
