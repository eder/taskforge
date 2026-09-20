import { randomUUID } from 'node:crypto';
import { AgentAssignment, VerificationResult } from '@taskforge/shared';
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
      return runSequentialTeam(task, ctx, orderForStrategy(routing.strategy, selected));
    case 'parallel':
      return runConcurrentTeam(task, ctx, routing, selected);
    case 'competitive':
      return runCompetitiveTeam(task, ctx, selected);
    default:
      ctx.onProgress?.(
        `[${task.id}] Collaboration strategy '${routing.strategy}' has no dedicated coordinator yet; falling back to sequential handoff.`,
      );
      return runSequentialTeam(task, ctx, selected);
  }
}

/**
 * 'review' means implementer + N reviewers, so the implementer must run
 * first regardless of the order roles were requested in; 'pair' and
 * 'collaborative' keep the selection order the router/selector produced.
 */
function orderForStrategy(
  strategy: RoutingDecision['strategy'],
  selected: SelectedAgentAssignment[],
): SelectedAgentAssignment[] {
  if (strategy !== 'review') return selected;
  const implementers = selected.filter((s) => s.roleRequest.role === 'implementer');
  if (implementers.length === 0) return selected;
  const rest = selected.filter((s) => s.roleRequest.role !== 'implementer');
  return [...implementers, ...rest];
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

/**
 * Chains all N selected agents through the same worktree/branch, one after
 * another (a real handoff, not a fresh copy each time). Used for 'pair'
 * (always exactly 2), 'review' (implementer + N reviewers, implementer
 * ordered first by orderForStrategy) and 'collaborative' (N coordinated
 * assignments) — previously only the first two of `selected` ever ran and
 * every agent beyond that was silently dropped.
 */
async function runSequentialTeam(
  task: Task,
  ctx: SchedulerContext,
  selected: SelectedAgentAssignment[],
): Promise<TeamExecutionResult> {
  const headCommit = ctx.baseCommit ?? (await ctx.gitService.getHeadCommit());
  const [lead, ...rest] = selected;

  const chain = [
    { selection: lead, assignment: buildAssignment(task, lead, task.contract.objective) },
    ...rest.map((selection) => ({
      selection,
      assignment: buildAssignment(
        task,
        selection,
        selection.roleRequest.objective || `Review and assist with ${task.contract.objective}`,
        'pending' as const,
      ),
    })),
  ];

  for (const step of chain) {
    ctx.assignmentRepo.create(step.assignment, ctx.runId);
  }

  if (rest.length > 0) {
    ctx.onProgress?.(
      `[${task.id}] Sequential handoff: ${chain
        .map((s) => `${s.selection.agent.name} (${s.selection.roleRequest.role})`)
        .join(' → ')}`,
    );
  }

  const outputs: string[] = [];
  let lastRes: Awaited<ReturnType<typeof executeGovernedAssignment>> | undefined;
  let worktree: { path: string; branchName?: string } | undefined;

  for (let i = 0; i < chain.length; i++) {
    const { selection, assignment } = chain[i];
    const label = i === 0 ? 'Lead' : 'Partner';

    const res = await executeGovernedAssignment(
      buildGovernedCtx(task, ctx, assignment, selection.agent, headCommit, {
        objectiveOverride: i === 0 ? undefined : assignment.objective,
        existingWorktree: worktree,
      }),
    );

    outputs.push(
      `[${label} - ${selection.agent.name} (${selection.roleRequest.role})]:\n${
        res.output ?? (i === 0 ? 'Implemented' : 'Reviewed and verified')
      }`,
    );
    lastRes = res;

    if (!res.success) {
      for (const remaining of chain.slice(i + 1)) {
        ctx.assignmentRepo.updateStatus(remaining.assignment.id, 'cancelled');
      }
      return { success: false, output: outputs.join('\n\n'), worktreePath: res.worktreePath };
    }

    worktree = { path: res.worktreePath, branchName: assignment.branchName };
  }

  return {
    success: true,
    commitHash: lastRes?.commitHash,
    worktreePath: lastRes?.worktreePath,
    output: outputs.join('\n\n'),
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

/**
 * True competitive strategy: each agent independently produces a full,
 * isolated solution to the same objective (its own worktree/branch, not a
 * shared investigation phase), then the candidates are evaluated and the
 * best one wins. Previously 'competitive' silently reused runConcurrentTeam
 * (parallel investigation → single implementer), which never actually
 * produced or compared competing solutions.
 */
async function runCompetitiveTeam(
  task: Task,
  ctx: SchedulerContext,
  selected: SelectedAgentAssignment[],
): Promise<TeamExecutionResult> {
  const headCommit = ctx.baseCommit ?? (await ctx.gitService.getHeadCommit());

  const candidates = selected.map((selection) => ({
    selection,
    assignment: buildAssignment(task, selection, selection.roleRequest.objective || task.contract.objective),
  }));

  for (const candidate of candidates) {
    ctx.assignmentRepo.create(candidate.assignment, ctx.runId);
  }

  ctx.onProgress?.(
    `[${task.id}] Competitive: ${candidates.length} independent solutions from ${candidates
      .map((c) => c.selection.agent.name)
      .join(', ')}`,
  );

  const attempts = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      result: await executeGovernedAssignment(
        buildGovernedCtx(task, ctx, candidate.assignment, candidate.selection.agent, headCommit),
      ),
    })),
  );

  const successful = attempts.filter((a) => a.result.success);

  if (successful.length === 0) {
    return {
      success: false,
      output: `All ${attempts.length} competing solutions failed:\n${attempts
        .map((a) => `[${a.selection.agent.name}]: ${a.result.output ?? a.result.message ?? 'failed'}`)
        .join('\n\n')}`,
    };
  }

  let winner = successful[0];
  let winnerVerification: VerificationResult | undefined;

  if (successful.length > 1) {
    const evaluated = await Promise.all(
      successful.map(async (candidate) => ({
        candidate,
        verification: await ctx.verificationRunner
          .verify({
            taskId: task.id,
            runId: ctx.runId,
            worktreePath: candidate.result.worktreePath,
            config: ctx.config,
            taskType: task.type,
          })
          .catch(
            (): VerificationResult => ({
              passed: false,
              checks: [],
              failureReason: 'verification threw while evaluating competing solution',
            }),
          ),
      })),
    );

    const passing = evaluated.filter((e) => e.verification.passed);
    const pool = passing.length > 0 ? passing : evaluated;
    pool.sort(
      (a, b) =>
        a.verification.checks.filter((c) => !c.success).length -
        b.verification.checks.filter((c) => !c.success).length,
    );

    winner = pool[0].candidate;
    winnerVerification = pool[0].verification;

    ctx.onProgress?.(
      `[${task.id}] Competitive: selected ${winner.selection.agent.name}'s solution (${
        winnerVerification.passed ? 'passed verification' : 'best of unverified attempts'
      })`,
    );
  }

  const combinedOutput = [
    `[Selected - ${winner.selection.agent.name} (${winner.selection.roleRequest.role})]:\n${
      winner.result.output ?? 'Implemented'
    }`,
    ...attempts
      .filter((a) => a !== winner)
      .map(
        (a) =>
          `[Not selected - ${a.selection.agent.name} (${a.selection.roleRequest.role}), ${
            a.result.success ? 'succeeded' : 'failed'
          }]:\n${a.result.output ?? a.result.message ?? ''}`,
      ),
  ].join('\n\n');

  return {
    success: true,
    commitHash: winner.result.commitHash,
    worktreePath: winner.result.worktreePath,
    output: combinedOutput,
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
