import {
  AgentCapabilities,
} from '@taskforge/shared';

import { BaseCliAdapter, CliAdapterOptions } from './base-cli-adapter.js';

export class CodexAdapter extends BaseCliAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly binaryName = 'codex';
  readonly stdinMode = 'close_after_spawn';
  readonly permissionProtocol = 'provider_native';

  protected providerEnvAllow(): string[] {
    return ['OPENAI_API_KEY', 'CODEX_API_KEY'];
  }

  constructor(options: CliAdapterOptions = {}) {
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        : ['exec', '--json'];
    super({
      ...options,
      defaultArgs,
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
