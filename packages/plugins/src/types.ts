import { TaskForgeConfig } from '@taskforge/shared';
import { Task, TaskGraph, Goal } from '@taskforge/core';

export interface PluginCapability {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface RunContext {
  runId: string;
  goalId: string;
  repoRoot: string;
  config: TaskForgeConfig;
}

export interface PlanContext {
  goal: Goal;
  repoRoot: string;
}

export interface TaskContext {
  task: Task;
  worktreePath: string;
  environment: Record<string, string>;
  prompt?: string;
  additionalInstructions?: string[];
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  commitHash?: string;
  message?: string;
  output?: string;
  durationMs?: number;
}

export interface VerificationContext {
  taskId: string;
  worktreePath: string;
  commands: string[];
}

export interface PluginVerificationResult {
  passed: boolean;
  gateName: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TaskForgePlugin {
  name: string;
  version: string;
  capabilities(): PluginCapability[];
  onRunStart?(ctx: RunContext): Promise<void>;
  beforePlan?(ctx: PlanContext): Promise<void>;
  afterPlan?(graph: TaskGraph): Promise<void>;
  beforeTask?(ctx: TaskContext): Promise<TaskContext>;
  afterTask?(result: TaskResult): Promise<void>;
  verify?(ctx: VerificationContext): Promise<PluginVerificationResult>;
  onRunComplete?(ctx: RunContext): Promise<void>;
}

export interface PluginErrorRecord {
  pluginName: string;
  hook: string;
  error: Error;
  timestamp: Date;
}
