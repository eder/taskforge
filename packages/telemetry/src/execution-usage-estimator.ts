import type { Task } from '@taskforge/core';
import type { RepositoryProfile, TaskType } from '@taskforge/shared';
import type { UsageCalibration } from './types.js';

export type UsageEstimateConfidence = 'low' | 'medium' | 'high';

export interface TaskExecutionUsageEstimate {
  taskId: string;
  taskTitle: string;
  assignmentCount: number;
  minTokens: number;
  expectedTokens: number;
  maxTokens: number;
  estimatedPromptTokensPerAssignment: number;
  complexity: 'lightweight' | 'standard' | 'heavy';
}

export interface RunUsageEstimate {
  minTokens: number;
  expectedTokens: number;
  maxTokens: number;
  confidence: UsageEstimateConfidence;
  baselineAssignments: number;
  breakdown: TaskExecutionUsageEstimate[];
  assumptions: string[];
}

export interface ExecutionUsageEstimateOptions {
  tasks: Task[];
  originalUserRequest?: string;
  /**
   * Baseline assignments known at planning time (for example, the Router's
   * selected team for a task). Tasks without a hint default to one assignment.
   */
  assignmentCounts?: Record<string, number>;
  repositoryProfile?: RepositoryProfile;
  calibrationByTaskType?: Partial<Record<TaskType, UsageCalibration>>;
}

interface UsageBand {
  minContext: number;
  expectedContext: number;
  maxContext: number;
  minOutput: number;
  expectedOutput: number;
  maxOutput: number;
  complexity: 'lightweight' | 'standard' | 'heavy';
}

function approximateTokens(text: string | undefined): number {
  if (!text) return 0;
  // Provider tokenizers differ and TaskForge supports multiple model
  // families. Four UTF-16 characters/token is deliberately approximate; the
  // range around this baseline carries the uncertainty instead of presenting a
  // fake exact tokenizer count.
  return Math.ceil(text.length / 4);
}

function taskContractText(task: Task): string {
  return [
    task.title,
    task.description,
    task.contract?.objective,
    ...(task.contract?.acceptanceCriteria ?? []),
    ...(task.contract?.allowedScope ?? []),
    ...(task.contract?.forbiddenChanges ?? []),
    ...(task.contract?.dependencies ?? []),
  ]
    .filter(Boolean)
    .join('\n');
}

function isDocumentationTask(task: Task): boolean {
  const text = `${task.title} ${task.description} ${task.contract?.objective ?? ''}`.toLowerCase();
  return (
    text.includes('readme') ||
    text.includes('docs') ||
    text.includes('documentation') ||
    text.includes('documenta') ||
    text.includes('typo') ||
    text.includes('translate') ||
    text.includes('traduz')
  );
}

function usageBandFor(task: Task): UsageBand {
  if (isDocumentationTask(task)) {
    return {
      minContext: 500,
      expectedContext: 1500,
      maxContext: 4000,
      minOutput: 300,
      expectedOutput: 800,
      maxOutput: 2000,
      complexity: 'lightweight',
    };
  }

  switch (task.type) {
    case 'investigation':
      return {
        minContext: 1500,
        expectedContext: 4500,
        maxContext: 12000,
        minOutput: 800,
        expectedOutput: 2200,
        maxOutput: 5000,
        complexity: 'standard',
      };
    case 'architecture':
      return {
        minContext: 1200,
        expectedContext: 3500,
        maxContext: 9000,
        minOutput: 700,
        expectedOutput: 1800,
        maxOutput: 4000,
        complexity: 'standard',
      };
    case 'testing':
      return {
        minContext: 1500,
        expectedContext: 4500,
        maxContext: 12000,
        minOutput: 800,
        expectedOutput: 1800,
        maxOutput: 4500,
        complexity: 'standard',
      };
    case 'review':
      return {
        minContext: 1500,
        expectedContext: 4000,
        maxContext: 10000,
        minOutput: 500,
        expectedOutput: 1500,
        maxOutput: 3500,
        complexity: 'standard',
      };
    case 'refactoring':
      return {
        minContext: 2500,
        expectedContext: 7000,
        maxContext: 18000,
        minOutput: 1500,
        expectedOutput: 3500,
        maxOutput: 8000,
        complexity: 'heavy',
      };
    case 'implementation':
    default: {
      const text = `${task.title} ${task.description}`.toLowerCase();
      const heavy =
        text.includes('refactor') ||
        text.includes('migration') ||
        text.includes('rewrite') ||
        text.includes('architecture');

      return heavy
        ? {
            minContext: 2500,
            expectedContext: 7500,
            maxContext: 18000,
            minOutput: 1500,
            expectedOutput: 4000,
            maxOutput: 8500,
            complexity: 'heavy',
          }
        : {
            minContext: 2000,
            expectedContext: 6000,
            maxContext: 16000,
            minOutput: 1200,
            expectedOutput: 3000,
            maxOutput: 7000,
            complexity: 'standard',
          };
    }
  }
}

function plannerAssignmentCount(task: Task): number | undefined {
  const collaboration = task.contract?.metadata?.collaboration;
  if (
    task.contract?.metadata?.recommendCollaboration &&
    collaboration &&
    Array.isArray(collaboration.requestedRoles) &&
    collaboration.requestedRoles.length > 0
  ) {
    return collaboration.requestedRoles.length;
  }
  return undefined;
}

/**
 * Estimates the observable coding-agent workload of a planned run.
 *
 * This is intentionally a range rather than a fake precise token count.
 * It accounts for the original request being repeated per assignment,
 * task-specific control context, expected repository reads and expected
 * model output. Provider-hidden reasoning/context, retries and failover are
 * not counted because TaskForge cannot reliably observe them before execution.
 */
export class ExecutionUsageEstimator {
  static estimateRun(options: ExecutionUsageEstimateOptions): RunUsageEstimate {
    const originalRequestTokens = approximateTokens(options.originalUserRequest);
    const breakdown: TaskExecutionUsageEstimate[] = [];
    let hintedAssignments = 0;

    for (const task of options.tasks) {
      const explicitCount = options.assignmentCounts?.[task.id];
      const plannerCount = plannerAssignmentCount(task);
      const assignmentCount = Math.max(1, Math.floor(explicitCount ?? plannerCount ?? 1));
      if (explicitCount !== undefined || plannerCount !== undefined) {
        hintedAssignments += 1;
      }

      const taskTokens = approximateTokens(taskContractText(task));
      // Fixed TaskForge control envelope: section labels, assignment metadata,
      // execution mode, safety boundary and formatting. This is deliberately
      // kept separate from repository context so future prompt changes can be
      // calibrated independently.
      const controlEnvelopeTokens = 450;
      const promptTokens = originalRequestTokens + taskTokens + controlEnvelopeTokens;
      const band = usageBandFor(task);

      let minPerAssignment = promptTokens + band.minContext + band.minOutput;
      let expectedPerAssignment =
        promptTokens + band.expectedContext + band.expectedOutput;
      let maxPerAssignment = promptTokens + band.maxContext + band.maxOutput;

      const calibration = options.calibrationByTaskType?.[task.type];
      if (calibration && calibration.sampleSize >= 3) {
        minPerAssignment = Math.max(
          promptTokens,
          Math.round(minPerAssignment * calibration.p25Ratio),
        );
        expectedPerAssignment = Math.max(
          minPerAssignment,
          Math.round(expectedPerAssignment * calibration.medianRatio),
        );
        maxPerAssignment = Math.max(
          expectedPerAssignment,
          Math.round(maxPerAssignment * calibration.p75Ratio),
        );
      }

      breakdown.push({
        taskId: task.id,
        taskTitle: task.title,
        assignmentCount,
        minTokens: minPerAssignment * assignmentCount,
        expectedTokens: expectedPerAssignment * assignmentCount,
        maxTokens: maxPerAssignment * assignmentCount,
        estimatedPromptTokensPerAssignment: promptTokens,
        complexity: band.complexity,
      });
    }

    const minTokens = breakdown.reduce((sum, item) => sum + item.minTokens, 0);
    const expectedTokens = breakdown.reduce((sum, item) => sum + item.expectedTokens, 0);
    const maxTokens = breakdown.reduce((sum, item) => sum + item.maxTokens, 0);
    const baselineAssignments = breakdown.reduce((sum, item) => sum + item.assignmentCount, 0);

    const allAssignmentsKnown =
      options.tasks.length > 0 && hintedAssignments === options.tasks.length;
    const hasRepositoryProfile = Boolean(options.repositoryProfile);
    const calibrations = options.calibrationByTaskType ?? {};
    const calibratedTaskCount = options.tasks.filter(
      (task) => (calibrations[task.type]?.sampleSize ?? 0) >= 3,
    ).length;
    const allTasksCalibrated =
      options.tasks.length > 0 && calibratedTaskCount === options.tasks.length;
    const allCalibrationHigh =
      allTasksCalibrated &&
      options.tasks.every((task) => calibrations[task.type]?.confidence === 'high');

    const confidence: UsageEstimateConfidence =
      allAssignmentsKnown && allCalibrationHigh
        ? 'high'
        : allAssignmentsKnown || hasRepositoryProfile || calibratedTaskCount > 0
          ? 'medium'
          : 'low';

    const assumptions = [
      'Original user request is included once per baseline assignment.',
      'Repository context is estimated from task type; exact files read by coding agents are unknown before execution.',
      'Retries, provider failover, emergent collaboration and provider-hidden reasoning/context are excluded.',
      'Tasks without an explicit routing/collaboration hint assume one baseline assignment.',
      calibratedTaskCount > 0
        ? `Historical calibration applied to ${calibratedTaskCount}/${options.tasks.length} task(s) using provider-reported usage.`
        : 'No sufficiently large provider-reported usage history was available for calibration.',
    ];

    return {
      minTokens,
      expectedTokens,
      maxTokens,
      confidence,
      baselineAssignments,
      breakdown,
      assumptions,
    };
  }
}
