import {
  AssignmentRepository,
  CostRepository,
  EventRepository,
  ExecutionRepository,
  RunRepository,
  TaskForgeDatabase,
  TaskRepository,
} from '@taskforge/persistence';
import { OrchestrationEfficiencyReport } from './types.js';

const QUALITY_ROLES = new Set([
  'reviewer',
  'critic',
  'tester',
  'security_reviewer',
  'architecture_reviewer',
]);

function executionDurationMs(startedAt: string, finishedAt?: string): number {
  if (!finishedAt) return 0;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) return 0;
  return finish - start;
}

function unionDurationMs(intervals: Array<{ start: number; end: number }>): number {
  if (intervals.length === 0) return 0;
  const ordered = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let currentStart = ordered[0].start;
  let currentEnd = ordered[0].end;

  for (let i = 1; i < ordered.length; i++) {
    const next = ordered[i];
    if (next.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, next.end);
    } else {
      total += currentEnd - currentStart;
      currentStart = next.start;
      currentEnd = next.end;
    }
  }
  total += currentEnd - currentStart;
  return total;
}

function isTaskCompleted(status: string): boolean {
  return status === 'completed' || status === 'verified' || status === 'integrated';
}

export class OrchestrationEfficiencyAnalyzer {
  constructor(private db: TaskForgeDatabase) {}

  analyze(runId: string): OrchestrationEfficiencyReport {
    const runRepo = new RunRepository(this.db);
    const taskRepo = new TaskRepository(this.db);
    const assignmentRepo = new AssignmentRepository(this.db);
    const executionRepo = new ExecutionRepository(this.db);
    const eventRepo = new EventRepository(this.db);
    const costRepo = new CostRepository(this.db);

    const run = runRepo.get(runId);
    const tasks = taskRepo.listByRun(runId);
    const assignments = assignmentRepo.listByRun(runId);
    const executions = executionRepo.listByRun(runId);
    const events = eventRepo.listByRun(runId);
    const costs = costRepo
      .listByRun(runId)
      .filter((item) => item.usageSource === 'provider_reported' && item.totalTokens > 0);

    const usefulAssignments = assignments.filter((a) => a.status === 'completed').length;
    const wasted = assignments.filter((a) => a.status === 'failed' || a.status === 'cancelled');
    const wastedAssignmentIds = new Set(wasted.map((a) => a.id));
    const wastedAssignments = wasted.length;
    const assignmentCount = assignments.length;
    const wastedAssignmentRatio = assignmentCount > 0 ? wastedAssignments / assignmentCount : 0;

    const uniqueAgents = new Set(assignments.map((a) => a.agentId)).size;
    const assignmentsByTask = new Map<string, typeof assignments>();
    for (const assignment of assignments) {
      const list = assignmentsByTask.get(assignment.taskId) ?? [];
      list.push(assignment);
      assignmentsByTask.set(assignment.taskId, list);
    }

    let retryOrFailoverAssignments = 0;
    for (const taskAssignments of assignmentsByTask.values()) {
      const sorted = [...taskAssignments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let sawFailure = false;
      for (const assignment of sorted) {
        if (assignment.status === 'failed' || assignment.status === 'cancelled') {
          sawFailure = true;
          continue;
        }
        if (sawFailure) retryOrFailoverAssignments++;
      }
    }

    const providerReportedTokens = costs.reduce((sum, item) => sum + item.totalTokens, 0);
    const wastedProviderTokens = costs
      .filter((item) => item.assignmentId && wastedAssignmentIds.has(item.assignmentId))
      .reduce((sum, item) => sum + item.totalTokens, 0);
    const wastedTokenRatio =
      providerReportedTokens > 0 ? wastedProviderTokens / providerReportedTokens : undefined;
    const plannedTokens = costs.reduce((sum, item) => sum + item.plannedEstimatedTokens, 0);
    const tokenVarianceRatio =
      plannedTokens > 0 ? providerReportedTokens / plannedTokens : undefined;

    const completedIntervals = executions
      .filter((execution) => execution.finishedAt)
      .map((execution) => {
        const start = Date.parse(execution.startedAt);
        const end = execution.finishedAt ? Date.parse(execution.finishedAt) : start;
        return { start, end };
      })
      .filter(
        (interval) =>
          Number.isFinite(interval.start) &&
          Number.isFinite(interval.end) &&
          interval.end > interval.start,
      );

    const serialExecutionMs = executions.reduce(
      (sum, execution) => sum + executionDurationMs(execution.startedAt, execution.finishedAt),
      0,
    );
    const activeExecutionMs = unionDurationMs(completedIntervals);
    const observedParallelOverlapMs = Math.max(0, serialExecutionMs - activeExecutionMs);
    const parallelismFactor =
      activeExecutionMs > 0 ? Number((serialExecutionMs / activeExecutionMs).toFixed(2)) : 1;

    const routingDecisions = events.filter((event) => event.type === 'ROUTING_DECIDED');
    const fanOutAssessments = routingDecisions
      .map((event) => event.payload.fanOutAssessment)
      .filter(
        (assessment): assessment is { requested: boolean; admitted: boolean } =>
          Boolean(assessment && typeof assessment === 'object'),
      );
    const fanOutDecisions = fanOutAssessments.filter((assessment) => assessment.requested).length;
    const admittedFanOutDecisions = fanOutAssessments.filter(
      (assessment) => assessment.requested && assessment.admitted,
    ).length;
    const rejectedFanOutDecisions = fanOutAssessments.filter(
      (assessment) => assessment.requested && !assessment.admitted,
    ).length;

    const completionGateRejections = events.filter(
      (event) => event.type === 'COMPLETION_GATE_REJECTED',
    ).length;
    const reworkCount = tasks.reduce((sum, task) => sum + task.reworkCount, 0);
    const firstPassCompleted = tasks.filter(
      (task) => task.reworkCount === 0 && isTaskCompleted(task.status),
    ).length;
    const firstPassRate = tasks.length > 0 ? firstPassCompleted / tasks.length : 1;

    const specializedQualityAssignments = assignments.filter(
      (assignment) => assignment.status === 'completed' && QUALITY_ROLES.has(assignment.role),
    ).length;

    const multiAgent =
      uniqueAgents > 1 ||
      Array.from(assignmentsByTask.values()).some((taskAssignments) => taskAssignments.length > 1);
    const runSucceeded = run?.status === 'completed';
    const timeBenefitObserved =
      multiAgent && observedParallelOverlapMs >= 1_000 && parallelismFactor >= 1.1;
    const qualityGuardSignalObserved =
      multiAgent &&
      specializedQualityAssignments > 0 &&
      runSucceeded &&
      completionGateRejections === 0;

    const tokenWasteAcceptable = wastedTokenRatio === undefined || wastedTokenRatio <= 0.2;
    const assignmentWasteAcceptable = wastedAssignmentRatio <= 0.2;

    let outcome: OrchestrationEfficiencyReport['outcome'] = 'inconclusive';
    const reasons: string[] = [];

    if (assignmentCount === 0) {
      reasons.push('No assignments were executed, so orchestration efficiency cannot be evaluated.');
    } else if (!multiAgent) {
      if (
        runSucceeded &&
        wastedAssignments === 0 &&
        reworkCount === 0 &&
        completionGateRejections === 0
      ) {
        outcome = 'right_sized';
        reasons.push('Single-agent execution completed first-pass without wasted assignments.');
      } else {
        outcome = 'inefficient';
        reasons.push('Execution was not multi-agent, but retries/rework created avoidable orchestration waste.');
      }
    } else if (
      runSucceeded &&
      assignmentWasteAcceptable &&
      tokenWasteAcceptable &&
      (timeBenefitObserved || qualityGuardSignalObserved)
    ) {
      outcome = 'fan_out_justified';
      if (timeBenefitObserved) {
        reasons.push('Concurrent execution produced measurable overlap between independent assignments.');
      }
      if (qualityGuardSignalObserved) {
        reasons.push('A completed specialist quality role contributed without completion-gate rejection.');
      }
    } else if (
      !assignmentWasteAcceptable ||
      !tokenWasteAcceptable ||
      (!timeBenefitObserved && !qualityGuardSignalObserved)
    ) {
      outcome = 'inefficient';
      if (!assignmentWasteAcceptable) {
        reasons.push('More than 20% of assignments failed or were cancelled.');
      }
      if (!tokenWasteAcceptable) {
        reasons.push('More than 20% of provider-reported tokens were spent on failed/cancelled assignments.');
      }
      if (!timeBenefitObserved && !qualityGuardSignalObserved) {
        reasons.push('No measurable parallel-time benefit or specialist quality signal was observed.');
      }
    } else {
      reasons.push('The run has mixed signals; more comparable executions are needed.');
    }

    return {
      runId,
      outcome,
      reasons,
      taskCount: tasks.length,
      assignmentCount,
      usefulAssignments,
      wastedAssignments,
      wastedAssignmentRatio,
      uniqueAgents,
      multiAgent,
      retryOrFailoverAssignments,
      fanOutDecisions,
      admittedFanOutDecisions,
      rejectedFanOutDecisions,
      providerReportedTokens,
      wastedProviderTokens,
      wastedTokenRatio,
      tokenVarianceRatio,
      serialExecutionMs,
      activeExecutionMs,
      observedParallelOverlapMs,
      parallelismFactor,
      completionGateRejections,
      reworkCount,
      firstPassRate,
      specializedQualityAssignments,
      runSucceeded,
      timeBenefitObserved,
      qualityGuardSignalObserved,
      tokenWasteAcceptable,
    };
  }
}
