import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentMessage,
  AgentResult,
  AgentSession,
} from '@taskforge/shared';

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;

  detect(): Promise<boolean>;
  capabilities(): Promise<AgentCapabilities>;
  execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult>;
  createSession?(assignment: AgentAssignment, context: AgentContext): Promise<AgentSession>;
  send?(sessionId: string, message: AgentMessage): Promise<void>;
  cancel?(sessionId: string): Promise<void>;
  /** Release a completed assignment's session (event loop + adapter-side bookkeeping); not a cancellation. */
  releaseSession?(assignmentId: string): void;
}
