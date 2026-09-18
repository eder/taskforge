export type TaskStatus =
  | 'proposed'
  | 'preflight'
  | 'negotiating'
  | 'accepted'
  | 'ready'
  | 'assigned'
  | 'running'
  | 'completed'
  | 'verification'
  | 'verified'
  | 'integrated'
  | 'failed'
  | 'retrying'
  | 'reassigned'
  | 'collaborative_escalation'
  | 'blocked';

export type TaskType =
  | 'implementation'
  | 'investigation'
  | 'review'
  | 'testing'
  | 'refactoring'
  | 'architecture';

export type AgentRole =
  | 'lead'
  | 'implementer'
  | 'researcher'
  | 'architecture_reviewer'
  | 'reviewer'
  | 'critic'
  | 'tester'
  | 'reproduction_engineer'
  | 'security_reviewer'
  | 'integrator';

export type CollaborationMode =
  | 'single'
  | 'pair'
  | 'parallel'
  | 'partitioned'
  | 'competitive'
  | 'review'
  | 'collaborative'
  | 'swarm';

export type AssignmentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface Constraint {
  type: string;
  value: string;
  enforcedAt?: string;
}

export interface TaskContract {
  objective: string;
  allowedScope: string[];
  forbiddenChanges: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
}

export interface AgentCapabilities {
  canRead: boolean;
  canWrite: boolean;
  canExecute: boolean;
  languages: string[];
  tools: string[];
}

export interface AgentAssignment {
  id: string;
  taskId: string;
  agentId: string;
  role: AgentRole;
  objective: string;
  status: AssignmentStatus;
  branchName?: string;
  worktreePath?: string;
}

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  description: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  approved: boolean;
  findings: ReviewFinding[];
}

export interface AgentResult {
  success: boolean;
  commitHash?: string;
  message: string;
  output?: string;
  durationMs: number;
  findings?: ReviewFinding[];
}

export interface AgentContext {
  worktreePath: string;
  task: TaskContract;
  assignment: AgentAssignment;
  environment?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface VerificationCheck {
  name: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  success: boolean;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  failureReason?: string;
}

export interface RepositoryProfile {
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  testCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  buildCommands: string[];
  hasECC: boolean;
  summary: string;
}

export type TaskPreflightDecision =
  | 'accept'
  | 'challenge'
  | 'need_context'
  | 'need_dependency'
  | 'recommend_collaboration'
  | 'recommend_split'
  | 'recommend_merge';

export interface CollaborationProposal {
  reason: string;
  requestedRoles: AgentRole[];
  suggestedAgents?: string[];
  expectedBenefit: string;
  urgency: 'normal' | 'high';
}

export interface TaskPreflightResult {
  decision: TaskPreflightDecision;
  understanding: string;
  concerns: string[];
  missingContext: string[];
  suggestedDependencies: string[];
  collaboration?: CollaborationProposal;
}

export type AgentMessageType =
  | 'question'
  | 'answer'
  | 'challenge'
  | 'evidence'
  | 'proposal'
  | 'review'
  | 'handoff'
  | 'blocker'
  | 'context_request';

export interface AgentMessage {
  id: string;
  runId: string;
  taskId: string;
  fromAssignmentId: string;
  toAssignmentId?: string;
  type: AgentMessageType;
  body: string;
  artifactRefs?: string[];
  createdAt: Date;
}
