import { randomUUID } from 'node:crypto';
import { AgentAssignment } from '@taskforge/shared';
import { Task } from '@taskforge/core';
import { AgentAdapter } from '@taskforge/agents';
import { AssignmentGraph, SynthesisCoordinator } from '@taskforge/collaboration';
import { RoutingDecision, SelectedAgentAssignment } from '@taskforge/router';
import { executeGovernedAssignment } from './governed-assignment.js';
import { SchedulerContext } from './deterministic-scheduler.js';

export interface TeamExecutionResult {
  success: boolean;
  commitHash?: string;
  output?: string;
  worktreePath?: string;
}

/**
 * Runs a routed multi-agent team through the same governance pipeline a
 * single-agent task uses (worktree + workspace + execution records, and
 * InteractionGateway-mediated permission/question/auth), dispatching purely
 * on `routing.strategy` rather than on how many agents were selected.
 */
export async function executeExecutionTeam(
  task: Task,
  ctx: SchedulerContext,
  routing: RoutingDecision,
  selected: SelectedAgentAssignment[],
): Promise<TeamExecutionResult> {
  reportDegradedStaffing(task, ctx, routing, selected);

  switch (routing.strategy) {
    case 'pair':
    case 'review':
    case 'collaborative':
      return runSequentialTeam(task, ctx, selected);
    case 'parallel':
    case 'competitive':
      return runConcurrentTeam(task, ctx, routing, selected);
    default:
      ctx.onProgress?.(
        `[${task.id}] Collaboration strategy '${routing.strategy}' has no dedicated coordinator yet; falling back to sequential handoff.`,
      );
      return runSequentialTeam(task, ctx, selected);
  }
}

function reportDegradedStaffing(
  task: Task,
  ctx: SchedulerContext,
  routing: RoutingDecision,
  selected: SelectedAgentAssignment[],
): void {
  const degraded = selected.filter((s) => s.degraded);
  if (degraded.length === 0 || !routing.communication?.required) return;

  ctx.onProgress?.(
    `[${task.id}] ⚠ Staffing degraded: ${degraded
      .map((d) => `${d.agent.name} covering ${d.roleRequest.role}`)
      .join(', ')} shares an agent with another role.`,
  );
  ctx.eventRepo.append({
    id: `evt-${randomUUID()}`,
    runId: ctx.runId,
    taskId: task.id,
    type: 'TEAM_STAFFING_DEGRADED',
    payload: {
      strategy: routing.strategy,
      degradedRoles: degraded.map((d) => ({ role: d.roleRequest.role, agentId: d.agent.id })),
    },
    timestamp: new Date(),
  });
}

async function runSequentialTeam(
  task: Task,
  ctx: SchedulerContext,
  selected: SelectedAgentAssignment[],
): Promise<TeamExecutionResult> {
  const headCommit = ctx.baseCommit ?? (await ctx.gitService.getHeadCommit());
  const [lead, partner] = selected;

  const leadAsgn = buildAssignment(task, lead, task.contract.objective);
  ctx.assignmentRepo.create(leadAsgn, ctx.runId);

  if (!partner) {
    const res = await executeGovernedAssignment(
      buildGovernedCtx(task, ctx, leadAsgn, lead.agent, headCommit),
    );
    return {
      success: res.success,
      commitHash: res.commitHash,
      output: res.output,
      worktreePath: res.worktreePath,
    };
  }

  const partnerAsgn = buildAssignment(
    task,
    partner,
    partner.roleRequest.objective || `Review and assist with ${task.contract.objective}`,
    'pending',
  );
  ctx.assignmentRepo.create(partnerAsgn, ctx.runId);

  ctx.onProgress?.(
    `[${task.id}] Sequential handoff: ${lead.agent.name} (${lead.roleRequest.role}) → ${partner.agent.name} (${partner.roleRequest.role})`,
  );

  const leadRes = await executeGovernedAssignment(
    buildGovernedCtx(task, ctx, leadAsgn, lead.agent, headCommit),
  );

  if (!leadRes.success) {
    ctx.assignmentRepo.updateStatus(partnerAsgn.id, 'cancelled');
    return { success: false, output: leadRes.output, worktreePath: leadRes.worktreePath };
  }

  // Partner continues in the lead's own worktree/branch (a real handoff, not a fresh copy).
  const partnerRes = await executeGovernedAssignment(
    buildGovernedCtx(task, ctx, partnerAsgn, partner.agent, headCommit, {
      objectiveOverride: partnerAsgn.objective,
      existingWorktree: { path: leadRes.worktreePath, branchName: leadAsgn.branchName },
    }),
  );

  if (!partnerRes.success) {
    return { success: false, output: partnerRes.output, worktreePath: partnerRes.worktreePath };
  }

  const combinedOutput = [
    `[Lead - ${lead.agent.name} (${lead.roleRequest.role})]:\n${leadRes.output ?? 'Implemented'}`,
    `[Partner - ${partner.agent.name} (${partner.roleRequest.role})]:\n${partnerRes.output ?? 'Reviewed and verified'}`,
  ].join('\n\n');

  return {
    success: true,
    commitHash: partnerRes.commitHash ?? leadRes.commitHash,
    worktreePath: partnerRes.worktreePath,
    output: combinedOutput,
  };
}

async function runConcurrentTeam(
  task: Task,
  ctx: SchedulerContext,
  routing: RoutingDecision,
  selected: SelectedAgentAssignment[],
): Promise<TeamExecutionResult> {
  const headCommit = ctx.baseCommit ?? (await ctx.gitService.getHeadCommit());
  const policy = routing.investigationPolicy ?? 'all_required';

  const implementer = selected.find((s) => s.roleRequest.role === 'implementer') ?? selected[0];
  const investigators = selected.filter((s) => s !== implementer);

  const asgnGraph = AssignmentGraph.buildParallelInvestigationGraph(
    task.id,
    investigators.map((inv) => ({
      id: inv.agent.id,
      role: inv.roleRequest.role,
      objective: inv.roleRequest.objective,
    })),
    {
      id: implementer.agent.id,
      role: implementer.roleRequest.role,
      objective: implementer.roleRequest.objective || task.contract.objective,
    },
  );

  for (const node of asgnGraph.getAllNodes()) {
    ctx.assignmentRepo.create(node.assignment, ctx.runId);
  }

  const completed = new Set<string>();
  const outputs: Array<{ role: string; agentId: string; output: string }> = [];
  const failedInvestigators: string[] = [];

  const runnable = asgnGraph.getRunnableAssignments(completed);
  await Promise.all(
    runnable.map(async (asgn) => {
      const agent = ctx.agentRegistry.get(asgn.agentId)!;
      const res = await executeGovernedAssignment(buildGovernedCtx(task, ctx, asgn, agent, headCommit));
      completed.add(asgn.id);
      if (res.success) {
        outputs.push({ role: asgn.role, agentId: asgn.agentId, output: res.output ?? 'Done' });
      } else {
        failedInvestigators.push(asgn.id);
      }
    }),
  );

  const investigatorCount = runnable.length;
  const failureRatio = investigatorCount > 0 ? failedInvestigators.length / investigatorCount : 0;

  const policyViolated =
    failedInvestigators.length > 0 &&
    ((policy === 'all_required') ||
      (policy === 'quorum' && failureRatio >= 0.5));

  if (policyViolated) {
    ctx.onProgress?.(
      `[${task.id}] Investigation phase failed under '${policy}' policy: ${failedInvestigators.length}/${investigatorCount} investigators failed.`,
    );
    return {
      success: false,
      output: `Investigation phase failed under '${policy}' policy (${failedInvestigators.length}/${investigatorCount} failed)`,
    };
  }

  const synthesisNodes = asgnGraph.getRunnableAssignments(completed);
  let synthesizedObjective = task.contract.objective;
  if (synthesisNodes.length > 0 && outputs.length > 0) {
    const synthesisNode = synthesisNodes[0];
    const synthesized = SynthesisCoordinator.synthesize({
      taskId: task.id,
      investigationOutputs: outputs,
    });
    synthesizedObjective = `${task.contract.objective}\n\nSynthesized Guidance: ${synthesized.recommendedFix}`;
    ctx.assignmentRepo.updateStatus(synthesisNode.id, 'completed');
    completed.add(synthesisNode.id);
  } else if (synthesisNodes.length > 0) {
    // best_effort with zero successful investigators: nothing to synthesize from.
    ctx.assignmentRepo.updateStatus(synthesisNodes[0].id, 'cancelled');
    completed.add(synthesisNodes[0].id);
  }

  const implNodes = asgnGraph.getRunnableAssignments(completed);
  if (implNodes.length === 0) {
    return { success: false, output: 'No implementation assignment available after synthesis' };
  }
  const implNode = implNodes[0];
  const implAgent = ctx.agentRegistry.get(implNode.agentId)!;
  const implRes = await executeGovernedAssignment(
    buildGovernedCtx(task, ctx, implNode, implAgent, headCommit, {
      objectiveOverride: synthesizedObjective,
    }),
  );

  return {
    success: implRes.success,
    commitHash: implRes.commitHash,
    worktreePath: implRes.worktreePath,
    output: implRes.output,
  };
}

function buildAssignment(
  task: Task,
  selection: SelectedAgentAssignment,
  objective: string,
  status: AgentAssignment['status'] = 'running',
): AgentAssignment {
  return {
    id: `asgn-${task.id}-${selection.agent.id}-${selection.roleRequest.role}`,
    taskId: task.id,
    agentId: selection.agent.id,
    role: selection.roleRequest.role,
    objective,
    status,
  };
}

function buildGovernedCtx(
  task: Task,
  ctx: SchedulerContext,
  assignment: AgentAssignment,
  agent: AgentAdapter,
  baseCommit: string,
  overrides: {
    objectiveOverride?: string;
    detached?: boolean;
    existingWorktree?: { path: string; branchName?: string };
  } = {},
) {
  return {
    runId: ctx.runId,
    baseCommit,
    repoRoot: ctx.repoRoot,
    config: ctx.config,
    task,
    assignment,
    agent,
    worktreeManager: ctx.worktreeManager,
    workspaceRepo: ctx.workspaceRepo,
    assignmentRepo: ctx.assignmentRepo,
    executionRepo: ctx.executionRepo,
    eventRepo: ctx.eventRepo,
    interactionGateway: ctx.interactionGateway,
    activityTracker: ctx.activityTracker,
    abortSignal: ctx.abortSignal,
    ...overrides,
  };
}
