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
