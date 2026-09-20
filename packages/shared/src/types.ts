export type TaskStatus =
  | 'proposed'
  | 'preflight'
  | 'negotiating'
  | 'accepted'
  | 'ready'
  | 'assigned'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'waiting_auth'
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
  'implementation' | 'investigation' | 'review' | 'testing' | 'refactoring' | 'architecture';

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
  | 'waiting_input'
  | 'waiting_permission'
  | 'waiting_auth'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionStatus =
  'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';

export interface PlanRevision {
  feedback?: string;
  revisionType?:
    | 'modify_dependency'
    | 'add_constraint'
    | 'assign_agent'
    | 'add_task'
    | 'split_task'
    | 'general_feedback';
  type?:
    | 'modify_dependency'
    | 'add_constraint'
    | 'assign_agent'
    | 'add_task'
    | 'split_task'
    | 'general_feedback';
  taskId?: string;
  details?: string | Record<string, unknown>;
}

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
  metadata?: Record<string, any>;
}

export type ConversationState =
  | 'IDLE'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'EXECUTING'
  | 'AWAITING_INTERACTION'
  | 'DELIVERY_READY';

export type StdinMode = 'closed' | 'interactive' | 'close_after_spawn';
export type PermissionProtocol = 'structured' | 'stdin' | 'provider_native' | 'unsupported';
export type QuestionProtocol = 'structured' | 'stdin' | 'provider_native' | 'unsupported';

export interface AgentCapabilities {
  canRead: boolean;
  canWrite: boolean;
  canExecute: boolean;
  languages: string[];
  tools: string[];
  stdinMode?: StdinMode;
  permissionProtocol?: PermissionProtocol;
  questionProtocol?: QuestionProtocol;
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
  completionReason?: CompletionFailureReason;
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

export interface DeniedAction {
  action: string;
  reason?: string;
  tool?: string;
  command?: string;
}

export interface ProviderExecutionOutcome {
  processExitCode: number;
  providerStatus?: string;
  finalResponse: string;
  deniedActions: DeniedAction[];
  unresolvedInteractions: string[];
  errors: string[];
  warnings: string[];
  artifacts: Array<{ path: string; description?: string; type?: string }>;
  runtimeLogRef?: string;
}

export type CompletionFailureReason =
  | 'NO_CHANGES_PRODUCED'
  | 'REQUIRED_ACTION_DENIED'
  | 'UNRESOLVED_INTERACTION'
  | 'HARNESS_FAILED'
  | 'EMPTY_PROVIDER_RESULT'
  | 'VERIFICATION_FAILED'
  | 'ACCEPTANCE_NOT_MET'
  | 'INVALID_PROVIDER_RESULT';

export interface CompletionEvidence {
  diffProduced?: boolean;
  commitProduced?: boolean;
  commitHash?: string;
  changedFiles?: string[];
  filesModified?: string[];
  commitsProduced?: string[];
  reviewFindingsCount?: number;
  investigationReportLength?: number;
  actionsExecuted?: string[];
  actionsDenied?: DeniedAction[];
  deniedActions?: DeniedAction[];
  verificationPassed?: boolean;
  findings?: ReviewFinding[];
  analysisReport?: string;
  artifacts?: Array<{ path: string; description?: string; type?: string }>;
  explanation?: string;
  noChangesAccepted?: boolean;
}

export interface CompletionGateResult {
  accepted: boolean;
  failureReason?: CompletionFailureReason;
  evidence: CompletionEvidence;
}

export interface AgentResult {
  success: boolean;
  commitHash?: string;
  message: string;
  output?: string;
  durationMs: number;
  findings?: ReviewFinding[];
  collaborationProposal?: CollaborationProposal;
  normalizedOutcome?: ProviderExecutionOutcome;
  completionReason?: CompletionFailureReason;
  completionEvidence?: CompletionEvidence;
}

export function generateRunId(): string {
  return `run-${Date.now()}`;
}

export interface ActiveAgentState {
  taskId: string;
  assignmentId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  role: string;
  status: string;
  startedAt: Date;
  lastActiveAt: Date;
  logPath?: string;
  attentionRequired?: {
    type: 'permission' | 'question' | 'auth';
    prompt: string;
    resource?: string;
  };
  criticalFindings?: ReviewFinding[];
}

export interface AgentContext {
  worktreePath: string;
  task: TaskContract;
  assignment: AgentAssignment;
  environment?: Record<string, string>;
  abortSignal?: AbortSignal;
  logPath?: string;
  onEvent?: (event: AgentRuntimeEvent) => Promise<void>;
  onActivity?: (activity: string) => void;
  onProgress?: (progress: string) => void;
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

export type PermissionDecision = 'allow' | 'deny' | 'ask_human';
export type PermissionCategory = 'filesystem' | 'commands' | 'git' | 'tools' | 'network' | 'custom';
export type InteractionType =
  'permission' | 'question' | 'confirmation' | 'input' | 'auth' | 'tool_approval';
export type InteractionStatus = 'pending' | 'resolved' | 'timed_out' | 'blocked' | 'denied';
export type InteractionPriority = 'low' | 'normal' | 'high' | 'urgent';
export type InteractionScope = 'once' | 'task' | 'run' | 'project';
export type ResolutionSource = 'policy' | 'context' | 'agent' | 'human';

export interface InteractionRequest {
  id: string;
  runId: string;
  taskId: string;
  assignmentId: string;
  agentId: string;
  type: InteractionType;
  prompt: string;
  category?: PermissionCategory | string;
  resource?: string;
  status: InteractionStatus;
  priority: InteractionPriority;
  timeoutMs?: number;
  scope?: InteractionScope;
  createdAt: string;
  resolvedAt?: string;
}

export interface InteractionResponse {
  id: string;
  requestId: string;
  decision: 'allow' | 'deny' | 'answer' | 'cancel';
  payload?: string;
  source: ResolutionSource;
  scope: InteractionScope;
  responderId?: string;
  createdAt: string;
}

export interface BaseAgentRuntimeEvent {
  type: string;
  sessionId: string;
  assignmentId: string;
  agentId: string;
  timestamp: string;
}

export interface AgentOutputEvent extends BaseAgentRuntimeEvent {
  type: 'output';
  channel: 'stdout' | 'stderr';
  text: string;
}

export interface AgentQuestionEvent extends BaseAgentRuntimeEvent {
  type: 'question';
  requestId: string;
  prompt: string;
  options?: string[];
}

export interface PermissionRequestEvent extends BaseAgentRuntimeEvent {
  type: 'permission_request';
  requestId: string;
  category: PermissionCategory | string;
  operation: string;
  resource: string;
  prompt: string;
}

export interface ConfirmationRequestEvent extends BaseAgentRuntimeEvent {
  type: 'confirmation_request';
  requestId: string;
  prompt: string;
}

export interface InputRequiredEvent extends BaseAgentRuntimeEvent {
  type: 'input_required';
  requestId: string;
  prompt: string;
}

export interface AuthenticationRequiredEvent extends BaseAgentRuntimeEvent {
  type: 'authentication_required';
  requestId: string;
  prompt: string;
  service?: string;
}

export interface ToolApprovalEvent extends BaseAgentRuntimeEvent {
  type: 'tool_approval';
  requestId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  prompt: string;
}

export interface AgentStatusEvent extends BaseAgentRuntimeEvent {
  type: 'status';
  status: AssignmentStatus;
  message?: string;
}

export interface AgentErrorEvent extends BaseAgentRuntimeEvent {
  type: 'error';
  error: string;
}

export interface AgentCompletedEvent extends BaseAgentRuntimeEvent {
  type: 'completed';
  result: AgentResult;
}

export type AgentRuntimeEvent =
  | AgentOutputEvent
  | AgentQuestionEvent
  | PermissionRequestEvent
  | ConfirmationRequestEvent
  | InputRequiredEvent
  | AuthenticationRequiredEvent
  | ToolApprovalEvent
  | AgentStatusEvent
  | AgentErrorEvent
  | AgentCompletedEvent;

export interface AgentSession {
  readonly sessionId: string;
  readonly assignmentId: string;
  events(): AsyncIterable<AgentRuntimeEvent>;
  send(message: AgentMessage | string): Promise<void>;
  respond(response: InteractionResponse): Promise<void>;
  /** User- or system-initiated abort of in-progress work (e.g. terminates the underlying process). */
  cancel(): Promise<void>;
  /** Normal end-of-life teardown after the assignment finished running; must not be reported as a cancellation. */
  close(): Promise<void>;
}

export type QuestionRoutingOutcome =
  'AUTO_RESOLVE' | 'ROUTE_TO_AGENT' | 'ASK_HUMAN' | 'POLICY_ALLOW' | 'POLICY_DENY' | 'BLOCK';
