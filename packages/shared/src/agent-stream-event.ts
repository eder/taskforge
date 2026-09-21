/**
 * Normalized, provider-agnostic view of what an agent is doing right now.
 * Every event carries enough identity to route it to the right cockpit tab
 * (runId/taskId/assignmentId/agentId/role) without the UI needing to know
 * anything about Claude/Codex/Antigravity's own wire formats.
 *
 * This is strictly operational/observable content -- messages the provider
 * already emitted, tool calls, command output, file operations, status and
 * errors. It is never a channel for hidden/private model reasoning.
 */
export interface AgentStreamEventBase {
  timestamp: Date;
  runId: string;
  taskId: string;
  assignmentId: string;
  agentId: string;
  role: string;
}

export interface AgentMessageEvent extends AgentStreamEventBase {
  type: 'agent_message';
  text: string;
}

export interface ToolStartedEvent extends AgentStreamEventBase {
  type: 'tool_started';
  tool: string;
  resource?: string;
}

export interface ToolResultEvent extends AgentStreamEventBase {
  type: 'tool_result';
  tool: string;
  summary?: string;
  success?: boolean;
}

export interface CommandStartedEvent extends AgentStreamEventBase {
  type: 'command_started';
  command: string;
}

export interface CommandOutputEvent extends AgentStreamEventBase {
  type: 'command_output';
  command: string;
  summary: string;
  lineCount?: number;
}

export interface FileReadEvent extends AgentStreamEventBase {
  type: 'file_read';
  path: string;
}

export interface FileEditEvent extends AgentStreamEventBase {
  type: 'file_edit';
  path: string;
}

export interface FileWriteEvent extends AgentStreamEventBase {
  type: 'file_write';
  path: string;
}

export interface StatusEvent extends AgentStreamEventBase {
  type: 'status';
  status: string;
}

export interface WarningEvent extends AgentStreamEventBase {
  type: 'warning';
  message: string;
}

export interface ErrorEvent extends AgentStreamEventBase {
  type: 'error';
  message: string;
}

export interface AttentionEvent extends AgentStreamEventBase {
  type: 'attention';
  attentionType: 'permission' | 'question' | 'auth';
  prompt: string;
  resource?: string;
}

export interface InvestigatorFailoverEvent extends AgentStreamEventBase {
  type: 'investigator_failover';
  stage: 'provider_failed' | 'reassigning' | 'recovered';
  failedAgentId: string;
  failedAgentName: string;
  replacementAgentId?: string;
  replacementAgentName?: string;
  reason?: string;
  resetAt?: string;
}

export interface CompletedEvent extends AgentStreamEventBase {
  type: 'completed';
  success: boolean;
  summary?: string;
}

export type AgentStreamEvent =
  | AgentMessageEvent
  | ToolStartedEvent
  | ToolResultEvent
  | CommandStartedEvent
  | CommandOutputEvent
  | FileReadEvent
  | FileEditEvent
  | FileWriteEvent
  | StatusEvent
  | WarningEvent
  | ErrorEvent
  | AttentionEvent
  | InvestigatorFailoverEvent
  | CompletedEvent;
