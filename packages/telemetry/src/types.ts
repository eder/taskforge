export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface TaskCostSummary {
  taskId: string;
  agentId: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunCostReport {
  runId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  breakdown: TaskCostSummary[];
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
}
