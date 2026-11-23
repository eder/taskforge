import { AgentStreamEvent, AgentStreamEventBase } from '@taskforge/shared';

export type AgentStreamEventIdentity = Omit<AgentStreamEventBase, 'timestamp'>;

/**
 * Normalizes a raw stdout/stderr chunk from Claude Code, Codex or Antigravity
 * into zero or more AgentStreamEvents. Pure and side-effect free: callers
 * decide what to do with the events (publish to a bus, log, ignore).
 *
 * This intentionally covers only operational/observable output -- provider
 * messages, tool calls, commands, file reads/edits/writes, status and
 * errors -- never private/hidden model reasoning.
 */
export function parseAgentStreamEvents(
  chunk: string,
  identity: AgentStreamEventIdentity,
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const lines = chunk.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        events.push(...parseStructuredLine(obj, identity));
        continue;
      } catch {
        // Not valid JSON on this line -- fall through and ignore it. Raw
        // non-JSON lines are noisy CLI chrome far more often than they are
        // meaningful content, and the raw log already preserves them
        // verbatim for debugging.
      }
    }
  }

  return events;
}

interface StructuredLine {
  type?: string;
  event?: string;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
    }>;
  };
  content_block?: {
    type?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
  };
  step_update?: {
    step_type?: string;
    text_delta?: string;
    description?: string;
    tool?: string;
  };
  item?: {
    type?: string;
    text?: string;
    command?: string;
    message?: string;
  };
  response?: string;
  result?: {
    response?: string;
  };
  error?: unknown;
  warning?: unknown;
}

function parseStructuredLine(raw: unknown, identity: AgentStreamEventIdentity): AgentStreamEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as StructuredLine;
  const out: AgentStreamEvent[] = [];
  const timestamp = new Date();
  const base = { ...identity, timestamp };

  // Claude Code: assistant message content (text + tool_use blocks)
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    for (const item of obj.message.content) {
      if (item.type === 'tool_use' && typeof item.name === 'string') {
        out.push(...toolUseToEvents(item.name, item.input, base));
      } else if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        out.push({ ...base, type: 'agent_message', text: item.text.trim() });
      }
    }
  }

  // Claude Code: streamed tool_use block start (before args are complete)
  if (
    obj.type === 'content_block_start' &&
    obj.content_block?.type === 'tool_use' &&
    typeof obj.content_block.name === 'string'
  ) {
    out.push({ ...base, type: 'tool_started', tool: obj.content_block.name });
  }

  // Claude Code: streamed text delta
  if (
    obj.type === 'content_block_delta' &&
    obj.delta?.type === 'text_delta' &&
    typeof obj.delta.text === 'string' &&
    obj.delta.text.length > 0
  ) {
    out.push({ ...base, type: 'agent_message', text: obj.delta.text });
  }

  // Antigravity: step_update (live agent_response text_delta or operational step status)
  if (obj.event === 'step_update') {
    if (
      obj.step_update?.step_type === 'agent_response' &&
      typeof obj.step_update.text_delta === 'string' &&
      obj.step_update.text_delta.length > 0
    ) {
      out.push({ ...base, type: 'agent_message', text: obj.step_update.text_delta });
    } else {
      const desc: string = obj.step_update?.description || obj.step_update?.tool || 'Executing step...';
      out.push({ ...base, type: 'status', status: desc });
    }
  }

  // Codex JSONL lifecycle. Current codex exec --json emits
  // item.started/item.completed envelopes with the item payload nested inside.
  if (
    (obj.type === 'item' || obj.type === 'item.started' || obj.type === 'item.completed') &&
    obj.item
  ) {
    if (
      obj.item.type === 'agent_message' &&
      typeof obj.item.text === 'string' &&
      obj.item.text.trim()
    ) {
      out.push({ ...base, type: 'agent_message', text: obj.item.text.trim() });
    } else if (typeof obj.item.command === 'string' && obj.item.command) {
      out.push({ ...base, type: 'command_started', command: obj.item.command });
    } else if (obj.item.type === 'error' && typeof obj.item.message === 'string') {
      out.push({ ...base, type: 'error', message: obj.item.message });
    } else {
      out.push({ ...base, type: 'status', status: obj.item.type || 'Processing...' });
    }
  }

  // Cross-provider: final response / result text
  if (typeof obj.response === 'string' && obj.response.trim()) {
    out.push({ ...base, type: 'agent_message', text: obj.response.trim() });
  } else if (
    obj.type === 'result' &&
    obj.result &&
    typeof obj.result.response === 'string' &&
    obj.result.response.trim()
  ) {
    out.push({ ...base, type: 'agent_message', text: obj.result.response.trim() });
  }

  // Cross-provider: errors / warnings
  if (obj.error) {
    out.push({
      ...base,
      type: 'error',
      message: typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error),
    });
  }
  if (obj.warning) {
    out.push({
      ...base,
      type: 'warning',
      message: typeof obj.warning === 'string' ? obj.warning : JSON.stringify(obj.warning),
    });
  }

  return out;
}

function toolUseToEvents(
  name: string,
  input: Record<string, unknown> | undefined,
  base: { timestamp: Date } & AgentStreamEventIdentity,
): AgentStreamEvent[] {
  const args = input ?? {};

  if (name === 'Bash' && typeof args.command === 'string') {
    return [{ ...base, type: 'command_started', command: args.command }];
  }
  if (name === 'Edit' && typeof args.file_path === 'string') {
    return [{ ...base, type: 'file_edit', path: args.file_path }];
  }
  if (name === 'Write' && typeof args.file_path === 'string') {
    return [{ ...base, type: 'file_write', path: args.file_path }];
  }
  if (name === 'Read' && typeof args.file_path === 'string') {
    return [{ ...base, type: 'file_read', path: args.file_path }];
  }

  return [{ ...base, type: 'tool_started', tool: name }];
}
