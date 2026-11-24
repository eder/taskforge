import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentResult,
} from '@taskforge/shared';
import { AgentAdapter } from './adapter-interface.js';
import type { StructuredQueryRequest, StructuredQueryResult } from './structured-output.js';

export interface OllamaAdapterOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxToolTurns?: number;
}

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.taskforge']);
const MAX_READ_CHARS = 24_000;
const MAX_SEARCH_MATCHES = 40;
const MAX_LIST_FILES = 200;

/**
 * Resolves a relative path strictly inside `worktreeRoot`, rejecting absolute
 * escapes, `..` traversal, `.git` metadata edits, and symlink escapes.
 */
function resolveSafeWorktreePath(worktreeRoot: string, rawPath: string): string {
  const cleaned = rawPath.trim().replace(/^\/+/, '');
  if (!cleaned) {
    throw new Error('Path must be a non-empty relative path inside the repository.');
  }
  const rootResolved = path.resolve(worktreeRoot);
  const candidate = path.resolve(rootResolved, cleaned);
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Path "${rawPath}" escapes the allowed worktree boundary.`);
  }
  const rel = path.relative(rootResolved, candidate);
  if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) {
    throw new Error(`Access to ".git" metadata is forbidden.`);
  }
  if (fs.existsSync(candidate)) {
    const realRoot = fs.realpathSync(rootResolved);
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`Symlink "${rawPath}" escapes the allowed worktree boundary.`);
    }
  }
  return candidate;
}

function walkFiles(root: string, subDir: string, maxFiles = MAX_LIST_FILES): string[] {
  const results: string[] = [];
  const startDir = subDir ? resolveSafeWorktreePath(root, subDir) : path.resolve(root);
  if (!fs.existsSync(startDir) || !fs.statSync(startDir).isDirectory()) return results;

  const stack = [startDir];
  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(path.relative(path.resolve(root), full));
      }
    }
  }
  return results.sort();
}

function searchInWorktree(root: string, query: string, subDir = ''): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const files = walkFiles(root, subDir, 300);
  const hits: string[] = [];
  for (const rel of files) {
    if (hits.length >= MAX_SEARCH_MATCHES) break;
    const full = path.join(root, rel);
    try {
      const stat = fs.statSync(full);
      if (stat.size > 256_000) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
          if (hits.length >= MAX_SEARCH_MATCHES) break;
        }
      }
    } catch {
      // skip unreadable file
    }
  }
  return hits;
}

function buildOllamaTools(mutationAllowed: boolean): Array<Record<string, unknown>> {
  const readTools: Array<Record<string, unknown>> = [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List repository files inside the worktree (optional relative subdirectory).',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: 'Optional relative directory path (e.g. "src").' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file inside the repository worktree.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path inside the repository.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Case-insensitive text search across repository files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Substring to search for.' },
            dir: { type: 'string', description: 'Optional relative directory to narrow the search.' },
          },
          required: ['query'],
        },
      },
    },
  ];

  if (!mutationAllowed) return readTools;

  return [
    ...readTools,
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Replace an exact target substring with replacement text in an existing file inside the worktree.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path to modify.' },
            target: { type: 'string', description: 'Exact existing text to replace.' },
            replacement: { type: 'string', description: 'New replacement text.' },
          },
          required: ['path', 'target', 'replacement'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a file inside the repository worktree.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path to write.' },
            content: { type: 'string', description: 'Complete file contents.' },
          },
          required: ['path', 'content'],
        },
      },
    },
  ];
}

function parseToolArgs(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw;
}

/**
 * First-class local open-weight coding agent & coordinator adapter powered by
 * Ollama (`http://127.0.0.1:11434` by default, or `OLLAMA_HOST`).
 *
 * - Full agentic tool-calling loop confined strictly inside `worktreePath`:
 *   `list_files`, `read_file`, `search_files`, plus `edit_file` / `write_file`
 *   when `mutationAllowed` is enabled.
 * - Automatic graceful fallback to plain chat when a local model does not
 *   support native Ollama tool calls.
 * - `structuredQuery()` support via Ollama JSON Schema `format`, enabling local
 *   zero-cost task planning, parallel DAG decomposition, and solution arbitration.
 */
export class OllamaAdapter implements AgentAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama Local';

  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private maxToolTurns: number;

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(
      /\/$/,
      '',
    );
    this.model = options.model || process.env.TASKFORGE_OLLAMA_MODEL || 'qwen2.5-coder:latest';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxToolTurns = options.maxToolTurns ?? 12;
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
      canWrite: true,
      canExecute: false,
      languages: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust'],
      tools: ['list_files', 'read_file', 'search_files', 'edit_file', 'write_file'],
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }

  /**
   * Answers one structured JSON question using Ollama's native JSON-schema
   * `format` constraint (zero cloud API cost) for local planning, parallel DAG
   * decomposition, and multi-agent solution arbitration.
   */
  async structuredQuery(request: StructuredQueryRequest): Promise<StructuredQueryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs || this.timeoutMs);
    const onAbort = () => controller.abort();
    request.abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: request.schema,
          options: { temperature: 0.1 },
          messages: [
            {
              role: 'system',
              content:
                'You are a deterministic engineering coordinator inside TaskForge. Return ONLY valid JSON matching the requested schema.',
            },
            { role: 'user', content: request.prompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Ollama structuredQuery HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const json = (await res.json()) as OllamaChatResponse;
      const content = (json.message?.content ?? '').trim();
      if (!content) {
        throw new Error('Ollama structuredQuery returned empty content');
      }

      const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const value = JSON.parse(cleaned);
      const tokens = (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0);
      return { value, tokens: tokens > 0 ? tokens : undefined };
    } finally {
      clearTimeout(timeout);
      request.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  private executeToolCall(
    name: string,
    args: Record<string, unknown>,
    worktreePath: string,
    mutationAllowed: boolean,
    assignment: AgentAssignment,
    context: AgentContext,
  ): string {
    const emit = (type: 'file_read' | 'file_write' | 'file_edit', filePath: string) => {
      context.onStreamEvent?.({
        type,
        path: filePath,
        runId: context.runId ?? 'direct',
        agentId: this.id,
        role: assignment.role,
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        timestamp: new Date(),
      });
    };

    try {
      if (name === 'list_files') {
        const dir = typeof args.dir === 'string' ? args.dir : '';
        const files = walkFiles(worktreePath, dir);
        return files.length > 0 ? files.join('\n') : '(no files found)';
      }

      if (name === 'read_file') {
        const relPath = String(args.path ?? '');
        const full = resolveSafeWorktreePath(worktreePath, relPath);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return `Error: file not found: ${relPath}`;
        }
        const text = fs.readFileSync(full, 'utf8');
        emit('file_read', relPath);
        return text.length > MAX_READ_CHARS
          ? `${text.slice(0, MAX_READ_CHARS)}\n... [truncated ${text.length - MAX_READ_CHARS} chars]`
          : text;
      }

      if (name === 'search_files') {
        const query = String(args.query ?? '');
        const dir = typeof args.dir === 'string' ? args.dir : '';
        const hits = searchInWorktree(worktreePath, query, dir);
        return hits.length > 0 ? hits.join('\n') : '(no matches)';
      }

      if (name === 'edit_file') {
        if (!mutationAllowed) {
          return 'Error: write tools are disabled in read-only mode.';
        }
        const relPath = String(args.path ?? '');
        const target = String(args.target ?? '');
        const replacement = String(args.replacement ?? '');
        const full = resolveSafeWorktreePath(worktreePath, relPath);
        if (!fs.existsSync(full)) {
          return `Error: file not found: ${relPath}`;
        }
        const current = fs.readFileSync(full, 'utf8');
        if (!target || !current.includes(target)) {
          return `Error: target text not found in ${relPath}. Read the file first and match exact text.`;
        }
        const next = current.replace(target, replacement);
        fs.writeFileSync(full, next, 'utf8');
        emit('file_edit', relPath);
        return `OK: updated ${relPath}`;
      }

      if (name === 'write_file') {
        if (!mutationAllowed) {
          return 'Error: write tools are disabled in read-only mode.';
        }
        const relPath = String(args.path ?? '');
        const content = String(args.content ?? '');
        const full = resolveSafeWorktreePath(worktreePath, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        emit('file_write', relPath);
        return `OK: wrote ${relPath} (${content.length} chars)`;
      }

      return `Error: unknown tool "${name}".`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort();
    context.abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const mutationAllowed = Boolean(context.mutationAllowed);
      const hasWorktree = Boolean(context.worktreePath && fs.existsSync(context.worktreePath));
      const tools = hasWorktree ? buildOllamaTools(mutationAllowed) : undefined;
      const scopeNote =
        mutationAllowed && context.task?.allowedScope?.length
          ? `\nAllowed write scope: ${context.task.allowedScope.join(', ')}. Do not modify files outside this scope.`
          : !mutationAllowed
            ? '\nMode: READ-ONLY. Do not attempt to modify files.'
            : '';

      const systemParts = [
        'You are a concise, accurate local software engineering agent participating inside TaskForge.',
        hasWorktree
          ? mutationAllowed
            ? 'You have workspace tools (list_files, read_file, search_files, edit_file, write_file). Read files before editing them, keep changes minimal and clean, and summarize what you changed.'
            : 'You have read-only workspace tools (list_files, read_file, search_files) to inspect files before answering.'
          : '',
        scopeNote,
        context.priorContext ? `\nProject context:\n${context.priorContext}` : '',
        context.conversationHistory ? `\nConversation history:\n${context.conversationHistory}` : '',
      ].filter(Boolean);

      const messages: OllamaChatMessage[] = [
        { role: 'system', content: systemParts.join('\n') },
        { role: 'user', content: assignment.objective },
      ];

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let finalOutput = '';
      let useTools = Boolean(tools && tools.length > 0);

      for (let turn = 0; turn < this.maxToolTurns; turn++) {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            messages,
            ...(useTools ? { tools } : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // Graceful fallback for local models that do not support Ollama native tool calling.
          if (useTools && res.status === 400 && /does not support tools|tool/i.test(text)) {
            useTools = false;
            continue;
          }
          return {
            success: false,
            message: `Ollama HTTP ${res.status}: ${text.slice(0, 200)}`,
            durationMs: Date.now() - start,
          };
        }

        const json = (await res.json()) as OllamaChatResponse;
        totalInputTokens += json.prompt_eval_count ?? 0;
        totalOutputTokens += json.eval_count ?? 0;

        const msgContent = (json.message?.content ?? '').trim();
        const toolCalls = json.message?.tool_calls;

        if (!useTools || !Array.isArray(toolCalls) || toolCalls.length === 0 || !hasWorktree) {
          finalOutput = msgContent;
          break;
        }

        messages.push({
          role: 'assistant',
          content: msgContent,
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const fnName = call.function?.name ?? '';
          const fnArgs = parseToolArgs(call.function?.arguments);
          const toolResult = this.executeToolCall(
            fnName,
            fnArgs,
            context.worktreePath,
            mutationAllowed,
            assignment,
            context,
          );
          messages.push({
            role: 'tool',
            content: toolResult,
          });
        }
      }

      if (finalOutput && context.onStreamEvent) {
        context.onStreamEvent({
          type: 'agent_message',
          text: finalOutput,
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
        message: finalOutput,
        output: finalOutput,
        durationMs: Date.now() - start,
        usage:
          totalInputTokens + totalOutputTokens > 0
            ? {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
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
