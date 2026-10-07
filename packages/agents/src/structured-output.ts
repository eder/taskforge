/**
 * Asking a coding-agent CLI one question and getting JSON back, for decisions that are not work on the
 * repository (today: planning). The caller states a schema; the CLI is run read-only and non-interactively.
 */
export interface StructuredQueryRequest {
  prompt: string;
  schema: Record<string, unknown>;
  /** Repository the agent may read to ground its answer. */
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface StructuredQueryResult {
  value: unknown;
  /** Input plus output tokens the CLI reported for the call, when it reports them. */
  tokens?: number;
}

/** `codex exec --json`: the last agent message is the answer; usage arrives on turn.completed. */
export function parseCodexStructuredOutput(stdout: string): StructuredQueryResult {
  let message: string | undefined;
  let tokens = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: {
      type?: string;
      message?: string;
      error?: { message?: string };
      item?: { type?: string; text?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message')
      message = event.item.text;
    if (event.type === 'turn.completed' && event.usage) {
      tokens += (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0);
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      throw new Error(String(event.message ?? event.error?.message ?? 'codex reported an error'));
    }
  }
  if (message === undefined) throw new Error('codex returned no final message');
  return { value: JSON.parse(message), tokens };
}

/**
 * `claude -p --output-format json`. The shape of a successful structured answer has not been
 * verified against a signed-in install: both `structured_output` and a JSON `result` are accepted.
 */
export function parseClaudeStructuredOutput(stdout: string): StructuredQueryResult {
  const out = JSON.parse(stdout) as {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
    usage?: Record<string, number | undefined>;
  };
  if (out.is_error) throw new Error(String(out.result ?? 'claude reported an error'));
  const value = out.structured_output ?? JSON.parse(String(out.result));
  const u = out.usage ?? {};
  const tokens =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return { value, tokens };
}
