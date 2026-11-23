import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentCapabilities,
  AgentContext,
} from '@taskforge/shared';

import { BaseCliAdapter, CliAdapterOptions } from './base-cli-adapter.js';
import { parseCodexLoginStatus, type AuthStatus } from './auth-status.js';
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

  private readonly hasCustomDefaultArgs: boolean;

  constructor(options: CliAdapterOptions = {}) {
    const hasCustom = Boolean(options.defaultArgs && options.defaultArgs.length > 0);
    const defaultArgs =
      hasCustom && options.defaultArgs
        ? options.defaultArgs
        // Orchestrated runs stay ephemeral; Direct Mode opts into native thread persistence
        // via `context.persistProviderSession` / `context.providerSessionId`.
        : ['exec', '--json', '--ephemeral'];
    super({
      ...options,
      defaultArgs,
    });
    this.hasCustomDefaultArgs = hasCustom;
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
    const userArgs = this.options.defaultArgs ?? [];
    const chosenByUser = userArgs.some(
      (a) => a === '-s' || a.startsWith('--sandbox') || a.startsWith('--dangerously-bypass') || a === '--full-auto',
    );
    const modelChosenByUser = userArgs.some(
      (a) => a === '-m' || a === '--model' || a.startsWith('--model=') || a.startsWith('model='),
    );
    const effortChosenByUser = userArgs.some((a) => a.includes('model_reasoning_effort'));
    const readOnly = context
      ? context.mutationAllowed === false || context.task.forbiddenChanges.includes('*')
      : false;

    const modelFlagsForResume: string[] = [];
    if (!modelChosenByUser && this.options.model) {
      modelFlagsForResume.push('-c', `model="${this.options.model}"`);
    }
    if (!effortChosenByUser && this.options.effort) {
      modelFlagsForResume.push('-c', `model_reasoning_effort="${this.options.effort}"`);
    }

    if (!this.hasCustomDefaultArgs && context?.providerSessionId) {
      const resumeArgs = ['exec', 'resume', '--json', ...modelFlagsForResume];
      if (!chosenByUser) {
        resumeArgs.push('-c', `sandbox_mode="${readOnly ? 'read-only' : 'workspace-write'}"`);
      }
      resumeArgs.push(context.providerSessionId, prompt);
      return resumeArgs;
    }

    let args = super.formatArgs(prompt, context);
    if (!this.hasCustomDefaultArgs && context?.persistProviderSession) {
      args = args.filter((a) => a !== '--ephemeral');
    }
    const extraBeforePrompt: string[] = [];
    if (!modelChosenByUser && this.options.model) {
      extraBeforePrompt.push('--model', this.options.model);
    }
    if (!effortChosenByUser && this.options.effort) {
      extraBeforePrompt.push('-c', `model_reasoning_effort="${this.options.effort}"`);
    }
    if (!chosenByUser && context) {
      extraBeforePrompt.push('--sandbox', readOnly ? 'read-only' : 'workspace-write');
    }
    if (extraBeforePrompt.length === 0) return args;
    return [...args.slice(0, -1), ...extraBeforePrompt, args[args.length - 1]];
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

  async authStatus(): Promise<AuthStatus> {
    try {
      const { stdout, exitCode } = await this.runQuickCommand(['login', 'status']);
      return parseCodexLoginStatus(stdout, exitCode);
    } catch {
      return { state: 'unknown' };
    }
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
