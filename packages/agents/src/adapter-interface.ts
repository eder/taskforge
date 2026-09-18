import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentMessage,
  AgentResult,
} from '@taskforge/shared';

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;

  detect(): Promise<boolean>;
  capabilities(): Promise<AgentCapabilities>;
  execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult>;
  send?(sessionId: string, message: AgentMessage): Promise<void>;
  cancel?(sessionId: string): Promise<void>;
}
