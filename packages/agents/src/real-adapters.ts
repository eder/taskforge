import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentMessage,
  AgentResult,
  AgentSession,
  AgentUsage,
} from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import { GitService } from '@taskforge/workspace';
import { AgentAdapter } from './adapter-interface.js';
import { AgentQuotaTracker } from './quota-tracker.js';
import { RealCliAgentSession } from './agent-session.js';
import { parseAgentStreamEvents } from './stream-event-parser.js';

export interface CliAdapterOptions {
  binaryPath?: string;
  defaultArgs?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Antigravity reports exhausted Gemini capacity in its stream before the CLI
 * necessarily exits. Keep this deliberately narrow to avoid interpreting
 * repository/test output that merely mentions HTTP 429 as provider state.
 */
export function isDefinitiveStreamingQuotaFailure(agentId: string, text: string): boolean {
  if (agentId !== 'agy') return false;
  return /RESOURCE_EXHAUSTED|individual quota reached|quota (?:reached|exceeded)/i.test(text);
}

function finiteTokenNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function firstTokenNumber(obj: any, keys: string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = finiteTokenNumber(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function usageFromObject(raw: any, modelName?: string): AgentUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const rawInputTokens =
    firstTokenNumber(raw, [
      'input_tokens',
      'inputTokens',
      'prompt_tokens',
      'promptTokens',
      'promptTokenCount',
    ]) ?? 0;
  const outputTokens =
    firstTokenNumber(raw, [
      'output_tokens',
      'outputTokens',
      'completion_tokens',
      'completionTokens',
      'candidatesTokenCount',
    ]) ?? 0;

  // OpenAI/Codex and Gemini report cached input as a subset of input tokens.
  // Claude reports cache read/creation as separate input categories. Normalize
  // both shapes into one invariant:
  //
  //   inputTokens       = all observed input, including cached input
  //   cachedInputTokens = subset of inputTokens
  //   totalTokens       = inputTokens + outputTokens
  //
  // This prevents telemetry/cost reporting from counting cache twice.
  const directCached =
    firstTokenNumber(raw, [
      'cached_input_tokens',
      'cachedInputTokens',
      'cached_tokens',
      'cachedTokens',
      'cachedContentTokenCount',
    ]) ?? 0;
  const cacheRead =
    firstTokenNumber(raw, ['cache_read_input_tokens', 'cacheReadInputTokens']) ?? 0;
  const cacheCreation =
    firstTokenNumber(raw, ['cache_creation_input_tokens', 'cacheCreationInputTokens']) ?? 0;
  const additiveCached = cacheRead + cacheCreation;
  const cachedInputTokens = directCached > 0 ? directCached : additiveCached;
  const inputTokens = rawInputTokens + (directCached > 0 ? 0 : additiveCached);

  const providerTotal = firstTokenNumber(raw, [
    'total_tokens',
    'totalTokens',
    'totalTokenCount',
  ]);
  const normalizedTotal = inputTokens + outputTokens;
  // Trust a provider total only when it follows the normalized invariant.
  // Older/malformed harnesses have reported totals that add cached input twice.
  const totalTokens =
    providerTotal !== undefined && providerTotal === normalizedTotal
      ? providerTotal
      : normalizedTotal;

  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cachedInputTokens > 0 ? cachedInputTokens : undefined,
    totalTokens,
    modelName,
    source: 'provider_reported',
  };
}

export abstract class BaseCliAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly binaryName: string;

  protected options: CliAdapterOptions;

  constructor(options: CliAdapterOptions = {}) {
    this.options = options;
  }

  get commandBinary(): string {
    return this.options.binaryPath || this.binaryName;
  }

  async detect(): Promise<boolean> {
    try {
      const result = await ProcessRunner.run({
        command: 'which',
        args: [this.commandBinary],
        timeoutMs: 5000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust'],
      tools: ['bash', 'file_editor', 'git'],
      stdinMode: 'interactive',
      permissionProtocol: 'structured',
      questionProtocol: 'structured',
    };
  }

  protected buildPrompt(assignment: AgentAssignment, context: AgentContext): string {
    const originalUserRequest = context.originalUserRequest;
    const hasOriginalUserRequest = Boolean(originalUserRequest?.trim());
    const readOnly =
      context.mutationAllowed === false || context.task.forbiddenChanges.includes('*');
    const writableScope =
      context.task.allowedScope.length === 0
        ? 'not explicitly scoped'
        : context.task.allowedScope.includes('*')
          ? 'all repository files'
          : context.task.allowedScope.join(', ');

    return [
      hasOriginalUserRequest ? 'Original user request:' : undefined,
      hasOriginalUserRequest ? originalUserRequest : undefined,
      hasOriginalUserRequest ? '' : undefined,
      'TaskForge assignment:',
      `Task ID: ${assignment.taskId}`,
      `Assignment ID: ${assignment.id}`,
      `Role: ${assignment.role}`,
      `Objective: ${assignment.objective}`,
      `Execution mode: ${readOnly ? 'READ_ONLY' : 'IMPLEMENTATION'}`,
      readOnly
        ? 'Repository access: read any repository files needed for this assignment'
        : `Writable scope: ${writableScope}`,
      readOnly
        ? 'Repository mutation: forbidden'
        : `Forbidden changes: ${context.task.forbiddenChanges.join(', ') || 'none'}`,
      readOnly
        ? 'Evidence policy: treat the current repository contents as the source of truth. Do not rely on memories or claims from prior sessions unless they are independently confirmed by files in this worktree.'
        : undefined,
      readOnly
        ? 'Provenance policy: clearly distinguish facts observed in repository files from inference; do not present inference as repository fact.'
        : undefined,
      'Acceptance criteria:',
      ...context.task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }

  protected formatArgs(prompt: string): string[] {
    if (this.options.defaultArgs && this.options.defaultArgs.length > 0) {
      return [...this.options.defaultArgs, prompt];
    }
    return ['-p', prompt];
  }

  protected extractActivity(chunk: string, callback?: (activity: string) => void): void {
    if (!callback) return;

    const lines = chunk.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const obj = JSON.parse(trimmed);

          // 1. Claude Code assistant content
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const item of obj.message.content) {
              if (item.type === 'tool_use') {
                const name = item.name;
                const input = item.input ?? {};
                if (name === 'Bash' && input.command) {
                  const cmd =
                    input.command.length > 45 ? `${input.command.slice(0, 42)}...` : input.command;
                  callback(`Bash: ${cmd}`);
                  return;
                }
                if (name === 'Edit' && input.file_path) {
                  callback(`Edit ${path.basename(input.file_path)}`);
                  return;
                }
                if (name === 'Read' && input.file_path) {
                  callback(`Read ${path.basename(input.file_path)}`);
                  return;
                }
                if (name === 'Write' && input.file_path) {
                  callback(`Write ${path.basename(input.file_path)}`);
                  return;
                }
                callback(`Tool ${name}`);
                return;
              }
              if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
                const snippet = item.text.trim().split('\n')[0];
                const cleaned = snippet.length > 50 ? `${snippet.slice(0, 47)}...` : snippet;
                callback(cleaned);
                return;
              }
            }
          }

          // 2. Claude Code content block start with tool_use
          if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
            callback(`Starting tool ${obj.content_block.name}...`);
            return;
          }

          // 3. AGY step update
          if (obj.event === 'step_update') {
            const desc =
              obj.step_update?.description || obj.step_update?.tool || 'Executing step...';
            const cleaned = desc.length > 50 ? `${desc.slice(0, 47)}...` : desc;
            callback(cleaned);
            return;
          }

          // 4. Codex JSONL item lifecycle. Current `codex exec --json`
          // emits item.started/item.completed with the payload under `item`.
          if (
            (obj.type === 'item' || obj.type === 'item.started' || obj.type === 'item.completed') &&
            obj.item
          ) {
            if (
              obj.item.type === 'agent_message' &&
              typeof obj.item.text === 'string' &&
              obj.item.text.trim()
            ) {
              const snippet = obj.item.text.trim().split('\n')[0];
              callback(snippet.length > 50 ? `${snippet.slice(0, 47)}...` : snippet);
              return;
            }
            const desc = obj.item.command || obj.item.type || 'Processing...';
            callback(desc.length > 50 ? `${desc.slice(0, 47)}...` : desc);
            return;
          }
        } catch {
          // ignore json parse error
        }
      }
    }

    const rawLines = chunk
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('{'));

    if (rawLines.length > 0) {
      const lastLine = rawLines[rawLines.length - 1];
      const cleaned = lastLine.length > 64 ? `${lastLine.slice(0, 61)}...` : lastLine;
      callback(cleaned);
    }
  }

  /**
   * Normalizes a raw chunk into AgentStreamEvents and hands each one to
   * context.onStreamEvent, when the caller wired one up. Additive to
   * extractActivity (a single display string): this is the richer,
   * tool-call-level feed a live cockpit UI or event bus can subscribe to.
   * Never throws -- a malformed chunk or a broken listener must never
   * interrupt agent execution.
   */
  protected publishStreamEvents(
    chunk: string,
    assignment: AgentAssignment,
    context: AgentContext,
  ): void {
    if (!context.onStreamEvent) return;
    try {
      const events = parseAgentStreamEvents(chunk, {
        runId: context.runId ?? '',
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        agentId: this.id,
        role: assignment.role,
      });
      for (const event of events) {
        context.onStreamEvent(event);
      }
    } catch {
      // best-effort: never let event normalization break execution
    }
  }

  /**
   * Extract provider-reported usage from the structured JSON emitted by the
   * CLI harnesses. Providers use different field names, so normalize only
   * known metadata containers and never scrape arbitrary assistant/tool text.
   *
   * A single CLI invocation normally emits one final cumulative usage object.
   * When intermediate snapshots are also present, prefer the last richest
   * candidate rather than summing snapshots and double-counting tokens.
   */
  public extractReportedUsage(rawStdout: string, rawStderr: string): AgentUsage | undefined {
    const combined = [rawStdout, rawStderr].filter(Boolean).join('\n');
    let best: AgentUsage | undefined;
    let bestScore = -1;

    const fallbackModel =
      this.id === 'agy' ? 'gemini' : this.id === 'claude' ? 'claude' : this.id;

    const consider = (raw: any, modelName?: string) => {
      const usage = usageFromObject(raw, modelName ?? fallbackModel);
      if (!usage) return;
      const score =
        (usage.inputTokens > 0 ? 1 : 0) +
        (usage.outputTokens > 0 ? 1 : 0) +
        ((usage.cachedInputTokens ?? 0) > 0 ? 1 : 0) +
        (usage.totalTokens > 0 ? 1 : 0) +
        (usage.modelName && usage.modelName !== fallbackModel ? 1 : 0);
      if (score >= bestScore) {
        best = usage;
        bestScore = score;
      }
    };

    for (const line of combined.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;

      try {
        const obj = JSON.parse(trimmed);
        const eventModel =
          (typeof obj.model === 'string' && obj.model) ||
          (typeof obj.model_name === 'string' && obj.model_name) ||
          (typeof obj.modelName === 'string' && obj.modelName) ||
          (typeof obj.message?.model === 'string' && obj.message.model) ||
          (typeof obj.result?.model === 'string' && obj.result.model) ||
          undefined;

        for (const candidate of [
          obj.usage,
          obj.usage_metadata,
          obj.usageMetadata,
          obj.token_usage,
          obj.tokenUsage,
          obj.result?.usage,
          obj.result?.usage_metadata,
          obj.result?.usageMetadata,
          obj.message?.usage,
          obj.stats?.usage,
        ]) {
          consider(candidate, eventModel);
        }

        const modelUsage = obj.modelUsage ?? obj.model_usage;
        if (modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
          for (const [model, usage] of Object.entries(modelUsage)) {
            consider(usage, model);
          }
        }
      } catch {
        // Malformed provider line: ignore it exactly as normalizeOutcome does.
      }
    }

    return best;
  }

  public normalizeOutcome(
    rawStdout: string,
    rawStderr: string,
    exitCode: number,
    logPath?: string,
  ): import('@taskforge/shared').ProviderExecutionOutcome {
    const combined = [rawStdout, rawStderr].filter(Boolean).join('\n');
    const lines = combined.split('\n');

    let providerStatus: string | undefined;
    let candidateResponse = '';
    const assistantTexts: string[] = [];
    const deniedActions: import('@taskforge/shared').DeniedAction[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const artifacts: Array<{ path: string; description?: string; type?: string }> = [];
    const usage = this.extractReportedUsage(rawStdout, rawStderr);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const obj = JSON.parse(trimmed);

          // 1. Antigravity & structured provider status
          if (typeof obj.status === 'string') {
            providerStatus = obj.status;
          }

          // 2. Denied actions (Antigravity & Claude)
          // Antigravity: denied_actions: ["RunCommand"] or [{ action: "RunCommand" }]
          const rawDenied = obj.denied_actions ?? obj.deniedActions;
          if (Array.isArray(rawDenied)) {
            for (const d of rawDenied) {
              if (typeof d === 'string') {
                deniedActions.push({ action: d });
              } else if (d && typeof d === 'object') {
                deniedActions.push({
                  action: d.action || d.name || 'UnknownAction',
                  reason: d.reason,
                  command: d.command,
                });
              }
            }
          }
          if (
            obj.type === 'action_denied' ||
            obj.event === 'action_denied' ||
            obj.type === 'permission_denied' ||
            obj.action === 'denied'
          ) {
            deniedActions.push({
              action: obj.action || obj.operation || obj.command || 'UnknownAction',
              reason: obj.reason,
              command: obj.command,
            });
          }

          // 3. Responses and results
          if (typeof obj.response === 'string' && obj.response.trim().length > 0) {
            candidateResponse = obj.response;
          } else if (typeof obj.result === 'string' && obj.result.trim().length > 0) {
            candidateResponse = obj.result;
          } else if (
            obj.type === 'result' &&
            obj.result &&
            typeof obj.result.response === 'string'
          ) {
            candidateResponse = obj.result.response;
          }

          // 4. Codex final/progress agent messages.
          // `codex exec --json` emits:
          // {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
          // Keep the last completed agent message as the final response.
          if (
            obj.type === 'item.completed' &&
            obj.item?.type === 'agent_message' &&
            typeof obj.item.text === 'string' &&
            obj.item.text.trim()
          ) {
            candidateResponse = obj.item.text;
          }

          // 4b. Assistant text content
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const item of obj.message.content) {
              if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
                assistantTexts.push(item.text);
              }
            }
          }

          // 5. Artifact tracking
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const item of obj.message.content) {
              if (item.type === 'tool_use' && (item.name === 'Edit' || item.name === 'Write')) {
                if (item.input?.file_path) {
                  artifacts.push({ path: item.input.file_path, type: 'modified_file' });
                }
              }
            }
          }

          // 6. Errors & warnings
          if (
            obj.type === 'error' &&
            typeof obj.message === 'string' &&
            obj.message.trim()
          ) {
            errors.push(obj.message.trim());
          }
          if (
            obj.type === 'turn.failed' &&
            typeof obj.error?.message === 'string' &&
            obj.error.message.trim()
          ) {
            errors.push(obj.error.message.trim());
          }
          if (
            obj.type === 'item.completed' &&
            obj.item?.type === 'error' &&
            typeof obj.item.message === 'string' &&
            obj.item.message.trim()
          ) {
            const message = obj.item.message.trim();
            if (/in-process app-server event stream lagged; dropped \d+ events?/i.test(message)) {
              warnings.push(message);
            } else {
              errors.push(message);
            }
          }
          if (obj.error) {
            errors.push(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error));
          }
          if (obj.warning) {
            warnings.push(
              typeof obj.warning === 'string' ? obj.warning : JSON.stringify(obj.warning),
            );
          }
        } catch {
          // ignore parse errors
        }
      } else {
        const jetskiMatch = trimmed.match(
          /(?:jetski:.*)?(?:a tool )?required the ["']?([A-Za-z0-9_]+)["']? permission.*(?:auto-denied|denied)/i,
        );
        if (jetskiMatch) {
          deniedActions.push({
            action: jetskiMatch[1],
            reason: trimmed,
          });
          errors.push(trimmed);
        } else {
          const denialMatch = trimmed.match(
            /(?:permission(?: was)? denied|action denied|denied action)[:\s]+(?:for action\s+)?([A-Za-z0-9_]+)(?:\(([^)]+)\))?/i,
          );
          if (denialMatch) {
            deniedActions.push({
              action: denialMatch[1],
              command: denialMatch[2],
              reason: trimmed,
            });
          }
        }
      }
    }

    let finalResponse = candidateResponse;
    if (!finalResponse && assistantTexts.length > 0) {
      finalResponse = assistantTexts.join('\n\n');
    }
    if (!finalResponse && rawStdout) {
      const nonJsonLines = rawStdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('{'));
      if (nonJsonLines.length > 0) {
        finalResponse = nonJsonLines.join('\n');
      }
    }

    if (!providerStatus) {
      providerStatus = exitCode === 0 && deniedActions.length === 0 ? 'SUCCESS' : 'FAILED';
    }

    // Capture non-JSON stderr lines if exit was non-zero and no errors recorded
    if (exitCode !== 0 && errors.length === 0 && rawStderr) {
      const nonJsonStderr = rawStderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('{'));
      if (nonJsonStderr.length > 0) {
        errors.push(nonJsonStderr.slice(-3).join('\n'));
      }
    }

    return {
      processExitCode: exitCode,
      providerStatus,
      finalResponse: (finalResponse ?? '').trim(),
      deniedActions,
      unresolvedInteractions: [],
      errors,
      warnings,
      artifacts,
      runtimeLogRef: logPath,
      usage,
    };
  }

  protected extractOutput(
    rawStdout: string,
    rawStderr: string,
    outcome?: import('@taskforge/shared').ProviderExecutionOutcome,
  ): string {
    const effectiveOutcome = outcome ?? this.normalizeOutcome(rawStdout, rawStderr, 0);
    if (effectiveOutcome && effectiveOutcome.finalResponse) {
      return effectiveOutcome.finalResponse;
    }

    // Extract non-JSON text lines if any, NEVER raw JSON
    const combined = [rawStdout, rawStderr].filter(Boolean).join('\n');
    const nonJsonLines = combined
      .split('\n')
      // eslint-disable-next-line no-control-regex
      .map((l) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim())
      .filter((l) => l.length > 0 && !l.startsWith('{') && !l.startsWith('['));

    if (nonJsonLines.length > 0) {
      return nonJsonLines.join('\n');
    }

    return '';
  }

  protected activeSessions: Map<string, RealCliAgentSession> = new Map();

  async createSession(assignment: AgentAssignment, context: AgentContext): Promise<AgentSession> {
    const sessionId = `cli-session-${assignment.id}`;
    const capabilities = await this.capabilities();
    const rawTerminalPromptFallback =
      capabilities.stdinMode === 'interactive' &&
      capabilities.permissionProtocol === 'unsupported' &&
      capabilities.questionProtocol === 'unsupported';

    const session = new RealCliAgentSession(sessionId, assignment.id, {
      adapterId: this.id,
      adapterName: this.name,
      taskId: assignment.taskId,
      // Supported providers already expose structured or provider-native
      // interaction semantics. Never infer human questions from their raw
      // stdout/stderr: tool output can legitimately contain strings such as
      // "Do you want to execute?" while grepping this repository.
      rawTerminalPromptFallback,
      onEvent: (event) => {
        context.onEvent?.(event);
      },
    });
    this.activeSessions.set(assignment.id, session);
    return session;
  }

  async send(sessionId: string, message: AgentMessage): Promise<void> {
    for (const session of this.activeSessions.values()) {
      if (session.sessionId === sessionId) {
        await session.send(message);
        return;
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    for (const session of this.activeSessions.values()) {
      if (session.sessionId === sessionId) {
        await session.cancel();
        return;
      }
    }
  }

  releaseSession(assignmentId: string): void {
    this.activeSessions.delete(assignmentId);
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    const isAvailable = await this.detect();
    if (!isAvailable) {
      return {
        success: false,
        message: `${this.name} CLI ('${this.commandBinary}') is not installed or not in PATH`,
        durationMs: Date.now() - startTime,
      };
    }

    let session = this.activeSessions.get(assignment.id);
    if (!session) {
      session = (await this.createSession(assignment, context)) as RealCliAgentSession;
    }

    const prompt = this.buildPrompt(assignment, context);
    const args = this.formatArgs(prompt);
    const timeoutMs =
      context.timeoutMs ??
      this.options.timeoutMs ??
      300000; // direct adapter callers retain the historical 5-minute fallback

    const caps = await this.capabilities();
    const closeStdinOnSpawn = caps.stdinMode === 'close_after_spawn';

    let availabilityTail = '';
    let liveQuotaDetected = false;
    const inspectLiveAvailability = (chunk: string) => {
      if (liveQuotaDetected) return;
      availabilityTail = (availabilityTail + chunk).slice(-16_384);

      // Only act on complete streamed lines. This gives the provider a chance
      // to include its reset duration in the same structured error record.
      const lastNewline = availabilityTail.lastIndexOf('\n');
      if (lastNewline < 0) return;
      const completeOutput = availabilityTail.slice(0, lastNewline + 1);
      availabilityTail = availabilityTail.slice(lastNewline + 1);

      if (!isDefinitiveStreamingQuotaFailure(this.id, completeOutput)) return;
      if (!AgentQuotaTracker.getInstance().recordFailure(this.id, completeOutput)) return;

      liveQuotaDetected = true;
      context.onActivity?.('Provider quota exhausted — stopping this assignment immediately.');
      if (session instanceof RealCliAgentSession) {
        void session.cancel();
      }
    };

    const result = await ProcessRunner.run({
      command: this.commandBinary,
      args,
      cwd: context.worktreePath,
      closeStdinOnSpawn,
      env: {
        ...context.environment,
        ...this.options.env,
      },
      envPolicy: {
        inherit: false,
        allow: [
          'PATH',
          'HOME',
          'USER',
          'SHELL',
          'TMPDIR',
          'NODE_ENV',
          'LANG',
          'TERM',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'CLAUDE_API_KEY',
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN',
          'OPENAI_API_KEY',
          'TASKFORGE_OPENAI_API_KEY',
          'CODEX_API_KEY',
          'GEMINI_API_KEY',
          'GOOGLE_API_KEY',
          'SSH_AUTH_SOCK',
          'GIT_AUTHOR_NAME',
          'GIT_AUTHOR_EMAIL',
          'GIT_COMMITTER_NAME',
          'GIT_COMMITTER_EMAIL',
          'PNPM_HOME',
          'NVM_DIR',
          'DENO_INSTALL',
          'BUN_INSTALL',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_CACHE_HOME',
          'CI',
          'COLORTERM',
        ],
        denyPatterns: ['*PASSWORD*', '*SECRET*'],
      },
      abortSignal: context.abortSignal,
      timeoutMs,
      logPath: context.logPath,
      onSpawn: (child) => {
        if (session instanceof RealCliAgentSession) {
          session.attachProcess(child);
        }
      },
      onStdout: (chunk) => {
        if (session instanceof RealCliAgentSession) {
          session.handleOutputChunk(chunk, 'stdout');
        }
        inspectLiveAvailability(chunk);
        this.extractActivity(chunk, context.onActivity);
        this.publishStreamEvents(chunk, assignment, context);
      },
      onStderr: (chunk) => {
        if (session instanceof RealCliAgentSession) {
          session.handleOutputChunk(chunk, 'stderr');
        }
        inspectLiveAvailability(chunk);
        this.extractActivity(chunk, context.onActivity);
        this.publishStreamEvents(chunk, assignment, context);
      },
    });

    const git = new GitService(context.worktreePath);
    let commitHash: string | undefined;
    try {
      const status = await git.getStatus(context.worktreePath);
      if (!status.isClean) {
        if (context.mutationAllowed === false) {
          // Read-only task policy: never commit, and never leave a mutation
          // behind, regardless of what the provider process attempted.
          context.onActivity?.(
            `Blocked by task policy: discarding uncommitted repository changes (${status.uncommittedFiles.length} file(s)) -- mutation is not allowed for this task.`,
          );
          await git.discardAllChanges(context.worktreePath);
          commitHash = status.headCommit;
        } else {
          commitHash = await git.stageAndCommit(
            `feat(${assignment.taskId}): completed by ${this.name}`,
            context.worktreePath,
          );
        }
      } else {
        commitHash = status.headCommit;
      }
    } catch {
      // ignore git error if any
    }

    const outcome = this.normalizeOutcome(
      result.stdout,
      result.stderr,
      result.exitCode,
      context.logPath,
    );
    const output = this.extractOutput(result.stdout, result.stderr, outcome);

    // If required actions were denied, the execution cannot be marked successful
    const hasDeniedRequiredActions = outcome.deniedActions.length > 0;
    const isExecutionSuccessful = result.exitCode === 0 && !hasDeniedRequiredActions;

    if (isExecutionSuccessful) {
      AgentQuotaTracker.getInstance().recordSuccess(this.id);
    } else {
      AgentQuotaTracker.getInstance().recordFailure(
        this.id,
        [result.stderr, result.stdout].filter(Boolean).join('\n'),
      );
    }

    const { message, completionReason } = this.classifyExecutionFailure(
      outcome,
      result.exitCode,
      result.stdout,
      result.stderr,
      hasDeniedRequiredActions,
    );

    return {
      success: isExecutionSuccessful,
      commitHash,
      message,
      output,
      durationMs: Date.now() - startTime,
      normalizedOutcome: outcome,
      completionReason,
      usage: outcome.usage,
    };
  }

  /**
   * Turns a finished (non-cancelled) CLI execution into a human-readable
   * message and a typed CompletionFailureReason. Kept as a standalone, public
   * method (like normalizeOutcome) so the classification of a given
   * stdout/stderr blob is directly unit-testable without spawning a process.
   */
  public classifyExecutionFailure(
    outcome: import('@taskforge/shared').ProviderExecutionOutcome,
    exitCode: number,
    rawStdout: string,
    rawStderr: string,
    hasDeniedRequiredActions: boolean,
  ): {
    message: string;
    completionReason?: import('@taskforge/shared').CompletionFailureReason;
  } {
    if (hasDeniedRequiredActions) {
      const deniedList = outcome.deniedActions.map((a) => a.action).join(', ');
      const detail = outcome.deniedActions
        .map((a) => a.reason || a.action)
        .filter(Boolean)
        .join('; ');
      const message = detail
        ? `${this.name} required action denied: ${detail}`
        : `${this.name} required action denied: ${deniedList}`;
      return { message, completionReason: 'REQUIRED_ACTION_DENIED' };
    }

    if (exitCode === 0) {
      return { message: `${this.name} completed successfully` };
    }

    const quotaPattern =
      /RESOURCE_EXHAUSTED|quota (?:reached|exceeded)|rate[ _-]?limit(?:ed)?|too many requests|\(code 429\)/i;
    const isQuotaError =
      outcome.errors.some((e) => quotaPattern.test(e)) || quotaPattern.test(rawStderr || rawStdout);

    if (isQuotaError) {
      // Search the FULL raw output (not just the last-N-lines fallback normalizeOutcome
      // keeps in outcome.errors) for the specific line that actually names the quota
      // failure, since it's often not the last line of output.
      const combinedSource = [rawStderr, rawStdout, ...outcome.errors].filter(Boolean).join('\n');
      const quotaLine =
        combinedSource
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .find((l) => quotaPattern.test(l)) ?? '';
      // Prefer the human-readable detail after "RESOURCE_EXHAUSTED (code N):", e.g.
      // "Individual quota reached. ... Resets in 59h30m58s."; fall back to the whole
      // matched line if that specific shape isn't present.
      const detailMatch = quotaLine.match(/RESOURCE_EXHAUSTED[^:]*:\s*(.+)/i);
      const detail = (detailMatch?.[1] ?? quotaLine).trim();
      const message = `${this.name} rate-limited/quota exceeded: ${detail || 'provider quota exceeded'}`;
      return { message, completionReason: 'PROVIDER_QUOTA_EXCEEDED' };
    }

    const authPattern = /oauth|authenticate|authentication|api[ _-]?key|unauthorized|forbidden/i;
    const isAuthError =
      outcome.errors.some((e) => authPattern.test(e)) || authPattern.test(rawStderr || rawStdout);

    if (isAuthError) {
      const authErr = (
        outcome.errors.find((e) => authPattern.test(e)) ||
        rawStderr ||
        rawStdout
      )
        .trim()
        .split('\n')[0];
      return {
        message: `${this.name} authentication failed: ${authErr}`,
        completionReason: 'HARNESS_FAILED',
      };
    }

    return {
      message: `${this.name} exited with code ${exitCode}`,
      completionReason: 'HARNESS_FAILED',
    };
  }
}

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly binaryName = 'claude';
  readonly stdinMode = 'interactive';
  readonly permissionProtocol = 'structured';

  constructor(options: CliAdapterOptions = {}) {
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        : ['--output-format=stream-json', '--verbose', '-p'];
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

export class CodexAdapter extends BaseCliAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly binaryName = 'codex';
  readonly stdinMode = 'close_after_spawn';
  readonly permissionProtocol = 'provider_native';

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

export class AntigravityAdapter extends BaseCliAdapter {
  readonly id = 'agy';
  readonly name = 'Google Antigravity';
  readonly binaryName = 'agy';
  readonly stdinMode = 'interactive';
  readonly permissionProtocol = 'structured';

  constructor(options: CliAdapterOptions = {}) {
    AntigravityAdapter.ensurePrerequisites();
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        : ['--output-format', 'stream-json', '-p'];
    super({
      ...options,
      defaultArgs,
    });
  }

  public static recoverQuotaFromRecentLogs(customHome?: string): boolean {
    const tracker = AgentQuotaTracker.getInstance();
    if (!tracker.isAvailable('agy')) return true;

    try {
      const home = customHome || process.env.HOME || os.homedir();
      const logDir = path.join(home, '.gemini', 'antigravity-cli', 'log');
      if (!fs.existsSync(logDir)) return false;

      const files = fs
        .readdirSync(logDir)
        .filter((name) => name.endsWith('.log'))
        .map((name) => {
          const fullPath = path.join(logDir, name);
          return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 8);

      for (const file of files) {
        const raw = fs.readFileSync(file.fullPath, 'utf8');
        const tail = raw.slice(-131_072);
        const quotaLine = tail
          .split('\n')
          .reverse()
          .find((line) =>
            /RESOURCE_EXHAUSTED|individual quota reached|quota (?:reached|exceeded)/i.test(line),
          );

        if (!quotaLine) continue;
        tracker.recordFailure('agy', quotaLine, file.mtimeMs);
        if (!tracker.isAvailable('agy')) return true;
      }
    } catch {
      // Best-effort recovery: inability to read provider logs must never block startup.
    }

    return false;
  }

  public static ensurePrerequisites(worktreeOrRepoPath?: string, customHome?: string): void {
    try {
      const home = customHome || process.env.HOME || os.homedir();
      const settingsDir = path.join(home, '.gemini', 'antigravity-cli');
      const settingsFile = path.join(settingsDir, 'settings.json');

      let settings: {
        permissions?: {
          allow?: string[];
          deny?: string[];
        };
        trustedWorkspaces?: string[];
        [key: string]: unknown;
      } = {};

      if (fs.existsSync(settingsFile)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        } catch {
          settings = {};
        }
      } else {
        fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
      }

      if (!settings.permissions) {
        settings.permissions = {};
      }
      if (!Array.isArray(settings.permissions.allow)) {
        settings.permissions.allow = [];
      }

      const requiredRules = [
        'read_file(*)',
        'write_file(*)',
        'edit_file(*)',
        'command(*)',
        'read_url(*)',
      ];

      let modified = false;
      for (const rule of requiredRules) {
        if (!settings.permissions.allow.includes(rule)) {
          settings.permissions.allow.unshift(rule);
          modified = true;
        }
      }

      if (worktreeOrRepoPath) {
        if (!Array.isArray(settings.trustedWorkspaces)) {
          settings.trustedWorkspaces = [];
        }
        const resolvedPath = path.resolve(worktreeOrRepoPath);
        if (!settings.trustedWorkspaces.includes(resolvedPath)) {
          settings.trustedWorkspaces.push(resolvedPath);
          modified = true;
        }
        const match = resolvedPath.match(/(.*?)\/\.taskforge\/worktrees/);
        if (match && match[1] && !settings.trustedWorkspaces.includes(match[1])) {
          settings.trustedWorkspaces.push(match[1]);
          modified = true;
        }
      }

      if (modified || !fs.existsSync(settingsFile)) {
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
    } catch {
      // ignore if settings directory or file is not writable
    }
  }

  async detect(): Promise<boolean> {
    AntigravityAdapter.ensurePrerequisites();
    AntigravityAdapter.recoverQuotaFromRecentLogs();
    return super.detect();
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    AntigravityAdapter.ensurePrerequisites(context.worktreePath);
    return super.execute(assignment, context);
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
