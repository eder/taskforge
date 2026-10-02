import {
  AgentCapabilities,
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
