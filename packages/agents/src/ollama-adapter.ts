import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentResult,
} from '@taskforge/shared';
import { AgentAdapter } from './adapter-interface.js';

export interface OllamaAdapterOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * First-class local open-weight model adapter powered by Ollama
 * (`http://127.0.0.1:11434` by default, or `OLLAMA_HOST`). Zero API cost and
 * completely air-gapped — supports `/model ollama <model>`, `@ollama <prompt>`,
 * `@ollama -> @codex`, and `/council` participation seamlessly.
 */
export class OllamaAdapter implements AgentAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama Local';

  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(
      /\/$/,
      '',
    );
    this.model = options.model || process.env.TASKFORGE_OLLAMA_MODEL || 'qwen2.5-coder:latest';
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  getModelConfig(): { model?: string; effort?: string } {
    return { model: this.model };
  }

  setModelConfig(config: { model?: string; effort?: string }): void {
    if ('model' in config && config.model?.trim()) {
      this.model = config.model.trim();
    }
  }

  async detect(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
        if (!res.ok) return false;
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        if (Array.isArray(data.models) && data.models.length > 0) {
          // If the default model isn't installed locally, auto-pick the first installed model
          const names = data.models.map((m) => m.name ?? '').filter(Boolean);
          if (names.length > 0 && !names.some((n) => n === this.model || n.startsWith(`${this.model}:`))) {
            this.model = names[0];
          }
          return true;
        }
        return false;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: false,
      canExecute: false,
      languages: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust'],
      tools: ['local_llm'],
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort();
    context.abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const systemParts = [
        'You are a concise, accurate local software engineering assistant participating inside TaskForge.',
        context.priorContext ? `\nProject context:\n${context.priorContext}` : '',
        context.conversationHistory ? `\nConversation history:\n${context.conversationHistory}` : '',
      ].filter(Boolean);

      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: systemParts.join('\n') },
            { role: 'user', content: assignment.objective },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          success: false,
          message: `Ollama HTTP ${res.status}: ${text.slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }

      const json = (await res.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const output = (json.message?.content ?? '').trim();
      const inputTokens = json.prompt_eval_count ?? 0;
      const outputTokens = json.eval_count ?? 0;

      if (output && context.onStreamEvent) {
        context.onStreamEvent({
          type: 'agent_message',
          text: output,
          runId: context.runId ?? 'direct',
          agentId: this.id,
          role: assignment.role,
          taskId: assignment.taskId,
          assignmentId: assignment.id,
          timestamp: new Date(),
        });
      }

      return {
        success: true,
        message: output,
        output,
        durationMs: Date.now() - start,
        usage:
          inputTokens + outputTokens > 0
            ? {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                modelName: this.model,
                source: 'provider_reported',
              }
            : undefined,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timeout);
      context.abortSignal?.removeEventListener('abort', onAbort);
    }
  }
}
