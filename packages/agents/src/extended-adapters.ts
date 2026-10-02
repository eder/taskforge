import { AgentCapabilities } from '@taskforge/shared';
import { BaseCliAdapter, CliAdapterOptions } from './base-cli-adapter.js';

/**
 * Opt-in adapters for additional coding-agent CLIs. They run non-interactively
 * (prompt as the final argument, stdin closed) and rely on the provider's own
 * permission handling, exactly like CodexAdapter. They are NOT registered
 * unless enabled under `agents.<id>` in config. Default arguments follow each
 * tool's documented non-interactive mode and can be overridden with
 * `agents.<id>.args` / `agents.<id>.command`.
 */
abstract class NonInteractiveCliAdapter extends BaseCliAdapter {
  readonly stdinMode = 'close_after_spawn';
  readonly permissionProtocol = 'provider_native';

  protected constructor(options: CliAdapterOptions, fallbackArgs: string[]) {
    super({
      ...options,
      defaultArgs:
        options.defaultArgs && options.defaultArgs.length > 0 ? options.defaultArgs : fallbackArgs,
    });
  }

  async capabilities(): Promise<AgentCapabilities> {
    const base = await super.capabilities();
    return {
      ...base,
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }
}

/** Cursor CLI (`cursor-agent`): print mode with streamed JSON; `--force` allows file edits. */
export class CursorAdapter extends NonInteractiveCliAdapter {
  readonly id = 'cursor';
  readonly name = 'Cursor CLI';
  readonly binaryName = 'cursor-agent';

  protected providerEnvAllow(): string[] {
    return ['CURSOR_API_KEY'];
  }

  constructor(options: CliAdapterOptions = {}) {
    super(options, ['--output-format', 'stream-json', '--force', '-p']);
  }
}

/**
 * Aider: one-shot `--message` run. Auto-commits are disabled so TaskForge
 * owns the commit that the Completion Gate and integration step inspect.
 */
export class AiderAdapter extends NonInteractiveCliAdapter {
  readonly id = 'aider';
  readonly name = 'Aider';
  readonly binaryName = 'aider';

  protected providerEnvAllow(): string[] {
    return ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'];
  }

  constructor(options: CliAdapterOptions = {}) {
    super(options, [
      '--yes-always',
      '--no-pretty',
      '--no-stream',
      '--no-auto-commits',
      '--no-check-update',
      '--message',
    ]);
  }
}

/** OpenCode: `opencode run "<prompt>"`. */
export class OpenCodeAdapter extends NonInteractiveCliAdapter {
  readonly id = 'opencode';
  readonly name = 'OpenCode';
  readonly binaryName = 'opencode';

  protected providerEnvAllow(): string[] {
    return ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
  }

  constructor(options: CliAdapterOptions = {}) {
    super(options, ['run']);
  }
}

/** Goose: `goose run --no-session -t "<prompt>"`. */
export class GooseAdapter extends NonInteractiveCliAdapter {
  readonly id = 'goose';
  readonly name = 'Goose';
  readonly binaryName = 'goose';

  protected providerEnvAllow(): string[] {
    return ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];
  }

  constructor(options: CliAdapterOptions = {}) {
    super(options, ['run', '--no-session', '-t']);
  }
}
