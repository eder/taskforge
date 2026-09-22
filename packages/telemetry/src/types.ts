export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface TaskCostSummary {
  taskId: string;
  assignmentId?: string;
  agentId: string;
  role?: string;
  modelName: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageSource: string;
  plannedEstimatedTokens: number;
  costUsd: number;
}

export interface RunCostReport {
  runId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalPlannedEstimatedTokens: number;
  breakdown: TaskCostSummary[];
}

export interface UsageAccuracyReport {
  runId: string;
  observedTokens: number;
  plannedEstimatedTokens: number;
  varianceRatio?: number;
  observedAssignments: number;
}

export interface UsageCalibration {
  taskType: string;
  agentId?: string;
  role?: string;
  sampleSize: number;
  p25Ratio: number;
  medianRatio: number;
  p75Ratio: number;
  confidence: 'low' | 'medium' | 'high';
}

export interface PerformanceDimensions {
  agentId: string;
  role: string;
  taskType: string;
  language?: string;
  complexity?: string;
}

export interface AgentPerformanceStats {
  agentId: string;
  role: string;
  taskType: string;
  sampleSize: number;
  confidence: 'high' | 'medium' | 'low';
  successRate: number;
  firstPassRate: number;
  averageDurationMs: number;
  costPerSuccessfulTask: number;
  reworkRate: number;
  escalationRate: number;
  qualityScore: number;
  compositeScore: number;
}

export interface StaffingBottlenecks {
  staffingCappedCount: number;
  collaborationRejectedCount: number;
  collaborationApprovedCount: number;
  collaborationDelayedCount: number;
}

export interface RunSummaryStats {
  runId: string;
  durationMs: number;
  totalCostUsd: number;
  tasksCount: number;
  tasksCompleted: number;
  tasksFailed: number;
  reworkCount: number;
  escalationsCount: number;
  firstPassRate: number;
  staffingBottlenecks?: StaffingBottlenecks;
}

export type OrchestrationEfficiencyOutcome =
  | 'right_sized'
  | 'fan_out_justified'
  | 'inefficient'
  | 'inconclusive';

export type ExecutionHealthStatus = 'excellent' | 'needs_attention' | 'inefficient' | 'inconclusive';
export type DimensionHealth = 'healthy' | 'attention' | 'uncertain';
export type ComparisonConfidence = 'low' | 'medium';

export interface OrchestrationEfficiencyReport {
  runId: string;
  outcome: OrchestrationEfficiencyOutcome;
  reasons: string[];
  taskCount: number;
  assignmentCount: number;
  usefulAssignments: number;
  wastedAssignments: number;
  wastedAssignmentRatio: number;
  uniqueAgents: number;
  multiAgent: boolean;
  retryOrFailoverAssignments: number;
  fanOutDecisions: number;
  admittedFanOutDecisions: number;
  rejectedFanOutDecisions: number;
  providerReportedTokens: number;
  providerInputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  providerOutputTokens: number;
  freshWorkTokens: number;
  cacheHitRatio?: number;
  wastedProviderTokens: number;
  wastedTokenRatio?: number;
  tokenVarianceRatio?: number;
  freshWorkVarianceRatio?: number;
  tokenComparisonConfidence: ComparisonConfidence;
  tokenEfficiency: DimensionHealth;
  serialExecutionMs: number;
  activeExecutionMs: number;
  observedParallelOverlapMs: number;
  parallelismFactor: number;
  completionGateRejections: number;
  reworkCount: number;
  firstPassRate: number;
  specializedQualityAssignments: number;
  runSucceeded: boolean;
  timeBenefitObserved: boolean;
  qualityGuardSignalObserved: boolean;
  tokenWasteAcceptable: boolean;
  qualityHealth: DimensionHealth;
  recoveryHealth: DimensionHealth;
  overallHealth: ExecutionHealthStatus;
}
