import type { StructuredQueryRequest, StructuredQueryResult } from './structured-output.js';
import type { AuthStatus } from './auth-status.js';
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
  /** Whether the CLI is signed in, from its own status command; free, no model call. Absent = unknown. */
  authStatus?(): Promise<AuthStatus>;
  /** Answer one question with JSON matching a schema, read-only (planning). Only some CLIs support it. */
  structuredQuery?(request: StructuredQueryRequest): Promise<StructuredQueryResult>;
  capabilities(): Promise<AgentCapabilities>;
  execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult>;
  createSession?(assignment: AgentAssignment, context: AgentContext): Promise<AgentSession>;
  send?(sessionId: string, message: AgentMessage): Promise<void>;
  cancel?(sessionId: string): Promise<void>;
  /** Release a completed assignment's session (event loop + adapter-side bookkeeping); not a cancellation. */
  releaseSession?(assignmentId: string): void;
}
