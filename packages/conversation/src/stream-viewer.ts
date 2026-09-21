import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActiveAgentState, AgentStreamEvent } from '@taskforge/shared';
import { colors } from './theme.js';

export interface StreamViewerOptions {
  activeAgent: ActiveAgentState;
  allActive?: ActiveAgentState[];
  maxLines?: number;
}

export class StreamViewer {
  /**
   * Renders one normalized AgentStreamEvent using the tool-call UX from the
   * cockpit spec (⚡ Read / ✎ Edit / ＋ Write / $ command / › message). This
   * is the structured-event counterpart to formatLine() (which parses raw
   * log text) -- used once a provider is emitting AgentStreamEvents via the
   * stream bus rather than only ever reading the persisted log tail.
   */
  public static formatStreamEvent(event: AgentStreamEvent): string | null {
    switch (event.type) {
      case 'agent_message':
        return `  ${colors.dim}›${colors.reset} ${event.text}`;
      case 'tool_started':
        return `  ${colors.cyan}⚡${colors.reset} ${event.tool}${event.resource ? `\n    ${event.resource}` : ''}`;
      case 'tool_result':
        return `  ${colors.dim}↳${event.summary ? ` ${event.summary}` : ' done'}${colors.reset}`;
      case 'file_read':
        return `  ${colors.cyan}⚡ Read${colors.reset}\n    ${event.path}`;
      case 'file_edit':
        return `  ${colors.yellow}✎ Edit${colors.reset}\n    ${event.path}`;
      case 'file_write':
        return `  ${colors.green}＋ Write${colors.reset}\n    ${event.path}`;
      case 'command_started':
        return `  ${colors.dim}$${colors.reset} ${event.command}`;
      case 'command_output':
        return `  ${colors.dim}↳ ${event.summary}${colors.reset}`;
      case 'status':
        return `  ${colors.dim}${event.status}${colors.reset}`;
      case 'warning':
        return `  ${colors.yellow}⚠ ${event.message}${colors.reset}`;
      case 'error':
        return `  ${colors.red}✕ ${event.message}${colors.reset}`;
      case 'attention':
        return `  ${colors.yellow}${colors.bold}▲ ${event.prompt}${colors.reset}`;
      case 'completed':
        return `  ${event.success ? colors.green + '✓' : colors.red + '✕'} ${event.summary ?? (event.success ? 'Completed' : 'Failed')}${colors.reset}`;
      default:
        return null;
    }
  }

  /**
   * Renders a focus-mode view for one assignment from its real
   * AgentStreamEvent history (streamEvents), falling back to the raw log
   * tail (via getStreamSnapshot's log-parsing path) only when no structured
   * events are available yet -- e.g. a FakeAgent-driven run, which never
   * publishes to the stream bus, or a provider that hasn't emitted anything
   * yet. tabs lists every active assignment (not just distinct tasks), since
   * several assignments can now legitimately share one taskId.
   */
  public static renderAssignmentFocusView(options: {
    activeAgent: ActiveAgentState;
    allActive: ActiveAgentState[];
    streamEvents: AgentStreamEvent[];
    maxLines?: number;
  }): string {
    const { activeAgent, allActive, streamEvents, maxLines = 25 } = options;

    let body: string;
    if (streamEvents.length > 0) {
      const lines = streamEvents
        .map((e) => this.formatStreamEvent(e))
        .filter((l): l is string => l !== null)
        .slice(-maxLines);
      body = lines.length > 0 ? lines.join('\n') : 'No structured events yet -- agent is starting...';
    } else {
      body = 'No output recorded yet. Agent is initializing...';
      if (activeAgent.logPath && fs.existsSync(activeAgent.logPath)) {
        try {
          const raw = fs.readFileSync(activeAgent.logPath, 'utf8');
          const formatted = raw
            .split('\n')
            .map((l) => this.formatLine(l))
            .filter((l): l is string => l !== null);
          const recent = formatted.slice(-maxLines).join('\n').trim();
          if (recent.length > 0) body = recent;
        } catch {
          // keep default body
        }
      }
    }

    const tabs = allActive
      .map((a, idx) => {
        const isCurrent = a.assignmentId === activeAgent.assignmentId;
        const tag = `[${idx + 1}] ${a.agentName} ${a.role}`;
        return isCurrent ? `${colors.bold}${colors.cyan}${tag}${colors.reset}` : `${colors.dim}${tag}${colors.reset}`;
      })
      .join('   ');

    const header = `  ${colors.brand}┌─ ${colors.bold}${activeAgent.taskId}${colors.reset}${colors.brand}  ${activeAgent.agentName} › ${activeAgent.role} ─────${colors.reset}`;
    const tabLine = allActive.length > 1 ? `  ${tabs}\n` : '';
    const divider = `  ${colors.brand}└${'─'.repeat(70)}┘${colors.reset}`;
    const footer =
      allActive.length > 1
        ? `  ${colors.dim}/focus <n> switch agent  •  /back overview  •  type a message to talk to ${activeAgent.agentName}${colors.reset}`
        : `  ${colors.dim}/back overview  •  type a message to talk to ${activeAgent.agentName}${colors.reset}`;

    return [header, tabLine, body, '', divider, footer].filter((s) => s !== '').join('\n');
  }
  public static formatLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);

        // Claude assistant message
        if (obj.type === 'assistant' && obj.message?.content) {
          const parts: string[] = [];
          for (const item of obj.message.content) {
            if (item.type === 'tool_use') {
              const name = item.name;
              const input = item.input ?? {};
              if (name === 'Bash' && input.command) {
                parts.push(`💻 [Bash] ${input.command}`);
              } else if (name === 'Edit' && input.file_path) {
                parts.push(`✏️ [Edit] ${path.basename(input.file_path)}`);
              } else if (name === 'Read' && input.file_path) {
                parts.push(`⚡ [Read] ${path.basename(input.file_path)}`);
              } else if (name === 'Write' && input.file_path) {
                parts.push(`📝 [Write] ${path.basename(input.file_path)}`);
              } else {
                parts.push(`⚙️ [${name}]`);
              }
            } else if (item.type === 'text' && item.text) {
              parts.push(item.text.trim());
            }
          }
          if (parts.length > 0) return parts.join(' | ');
        }

        // Claude user / tool result
        if (obj.type === 'user' && obj.message?.content) {
          for (const item of obj.message.content) {
            if (item.type === 'tool_result') {
              const res = typeof item.content === 'string' ? item.content.trim() : '';
              if (res) {
                const firstLine = res.split('\n')[0];
                return `  ↳ [Output] ${firstLine.slice(0, 80)}`;
              }
            }
          }
        }

        // Claude content block start with tool_use
        if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
          return `⚙️ Starting tool: ${obj.content_block.name}`;
        }

        // Claude or AGY result
        if (obj.type === 'result' && typeof obj.result === 'string') {
          return `✔ [Completed] ${obj.result.split('\n')[0].slice(0, 80)}`;
        }
        if (obj.event === 'result' && typeof obj.result === 'string') {
          return `✔ [Completed] ${obj.result.split('\n')[0].slice(0, 80)}`;
        }

        // AGY step update
        if (obj.event === 'step_update') {
          const desc = obj.step_update?.description || obj.step_update?.tool;
          if (desc) return `⚙️ [Step] ${desc}`;
        }

        // Codex item
        if (obj.type === 'item' && obj.item) {
          const desc = obj.item.command || obj.item.type;
          if (desc) return `💻 [Codex] ${desc}`;
        }

        // Ignore internal protocol metadata lines
        return null;
      } catch {
        // fall through to plain text
      }
    }

    // Strip ANSI escape codes
    // eslint-disable-next-line no-control-regex
    return trimmed.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  public static getStreamSnapshot(options: StreamViewerOptions): string {
    const { activeAgent, allActive = [activeAgent], maxLines = 15 } = options;

    let logContent = 'No output recorded yet. Agent is initializing...';
    if (activeAgent.logPath && fs.existsSync(activeAgent.logPath)) {
      try {
        const raw = fs.readFileSync(activeAgent.logPath, 'utf8');
        const lines = raw.split('\n');
        const formatted: string[] = [];
        for (const line of lines) {
          const f = this.formatLine(line);
          if (f) formatted.push(f);
        }
        const recent = formatted.slice(-maxLines).join('\n').trim();
        if (recent.length > 0) {
          logContent = recent;
        }
      } catch {
        // fallback
      }
    }

    const tabs = allActive
      .map((a, idx) => {
        const isCurrent = a.taskId === activeAgent.taskId;
        const tag = `[${idx + 1}: ${a.taskId}]`;
        return isCurrent ? `${colors.bold}${colors.cyan}${tag}${colors.reset}` : `${colors.dim}${tag}${colors.reset}`;
      })
      .join(' ');

    const header = `  ${colors.brand}┌─ [Live Stream: ${colors.bold}${activeAgent.taskId}${colors.reset}${colors.brand} (${activeAgent.agentName})] ─── ${tabs}${colors.brand} ───${colors.reset}`;
    const divider = `  ${colors.brand}└${'─'.repeat(70)}┘${colors.reset}`;
    const footer = `  ${colors.dim}Press [Esc] or type 'q' to return to prompt  •  [1-9] Switch Agent${colors.reset}`;

    return [header, '', logContent, '', divider, footer].join('\n');
  }
}
