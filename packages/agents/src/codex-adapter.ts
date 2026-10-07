import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentCapabilities,
  AgentContext,
} from '@taskforge/shared';

import { BaseCliAdapter, CliAdapterOptions } from './base-cli-adapter.js';
import {
  parseCodexStructuredOutput,
  type StructuredQueryRequest,
  type StructuredQueryResult,
} from './structured-output.js';

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
        // See the Claude adapter: TaskForge never resumes provider sessions.
        : ['exec', '--json', '--ephemeral'];
    super({
      ...options,
      defaultArgs,
    });
  }

  /**
   * Codex decides what it may write from the sandbox mode, which by default comes from the
   * user's own config: a project Codex has not been told to "trust" runs read-only, so on a
   * new repository the implementer could not create a single file ("blocked by the read-only
   * workspace") and the run ended with no changes. TaskForge states what each assignment
   * may do instead of depending on that config: workspace-write (the isolated worktree) when
   * it may change files, read-only when it may not. A sandbox flag the user put in their
   * agent configuration is left alone.
   */
  protected formatArgs(prompt: string, context?: AgentContext): string[] {
    const args = super.formatArgs(prompt, context);
    const chosenByUser = (this.options.defaultArgs ?? []).some(
      (a) => a === '-s' || a.startsWith('--sandbox') || a.startsWith('--dangerously-bypass') || a === '--full-auto',
    );
    if (chosenByUser || !context) return args;
    const readOnly = context.mutationAllowed === false || context.task.forbiddenChanges.includes('*');
    return [...args.slice(0, -1), '--sandbox', readOnly ? 'read-only' : 'workspace-write', args[args.length - 1]];
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

  /** `codex exec` in a read-only sandbox with the answer shape enforced by `--output-schema`. */
  async structuredQuery(request: StructuredQueryRequest): Promise<StructuredQueryResult> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-structured-'));
    try {
      const schemaFile = path.join(dir, 'schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(request.schema));
      const stdout = await this.runForStructuredAnswer(
        [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '-s',
          'read-only',
          '--output-schema',
          schemaFile,
          '--json',
          '-C',
          request.cwd,
          request.prompt,
        ],
        request,
      );
      return parseCodexStructuredOutput(stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
