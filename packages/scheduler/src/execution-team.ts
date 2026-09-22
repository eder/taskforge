import { randomUUID } from 'node:crypto';
import { AgentAssignment, VerificationResult, ReviewFinding } from '@taskforge/shared';
import { Task, computeTaskPriority } from '@taskforge/core';
import { AgentAdapter, AgentQuotaTracker } from '@taskforge/agents';
import { AssignmentGraph, SynthesisCoordinator } from '@taskforge/collaboration';
import { RoutingDecision, SelectedAgentAssignment, AgentSelector, RoleRequest } from '@taskforge/router';
import { executeGovernedAssignment } from './governed-assignment.js';
import { SchedulerContext } from './deterministic-scheduler.js';
import { TeamMemberReservation } from './concurrency-manager.js';
import { CompletionGate, resolveCompletionPolicy } from './completion-gate.js';
import { classifyTeamMemberFailure } from './failure-classification.js';

export interface TeamExecutionResult {
  success: boolean;
  /**
   * The commit that callers (CompletionGate, IntegrationService) should treat
   * as "the task's result". For sequential collaborative teams this is always
   * `integrationCommit` below — a commit that represents the COMPLETE
   * cumulative team output relative to `baseCommit`, never a single member's
   * intermediate delta.
   */
  commitHash?: string;
  /**
   * Cumulative squash commit whose diff against `baseCommit` equals the full
   * team result (baseline -> final shared worktree state). Only set for
   * sequential collaborative/pair teams that produced changes.
   */
  integrationCommit?: string;
  /** Actual HEAD of the shared team worktree after the last successful member. */
  finalCommit?: string;
  /** Task baseline commit the team started from. */
  baseCommit?: string;
  /** Number of distinct commits produced by team members between baseCommit and finalCommit. */
  teamCommitCount?: number;
  output?: string;
  worktreePath?: string;
  findings?: ReviewFinding[];
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
  const maxAgents = ctx.config.collaboration?.maxAgentsPerTask ?? 3;
  if (selected.length > maxAgents) {
    ctx.onProgress?.(
      `[${task.id}] Staffing capped from ${selected.length} to ${maxAgents} agents (collaboration.maxAgentsPerTask limit)`,
    );
  }
  const effectiveSelected = selected.length > maxAgents ? selected.slice(0, maxAgents) : selected;

  reportDegradedStaffing(task, ctx, routing, effectiveSelected);

  switch (routing.strategy) {
    case 'pair':
    case 'collaborative':
      return runCollaborativeTeam(task, ctx, effectiveSelected);
    case 'review':
      return runReviewTeam(task, ctx, effectiveSelected);
    case 'parallel':
      return runConcurrentTeam(task, ctx, routing, effectiveSelected);
    case 'competitive':
      return runCompetitiveTeam(task, ctx, effectiveSelected);
    default:
      ctx.onProgress?.(
        `[${task.id}] Collaboration strategy '${routing.strategy}' has no dedicated coordinator yet; falling back to collaborative handoff.`,
      );
      return runCollaborativeTeam(task, ctx, effectiveSelected);
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
 * Chains agents sequentially on a shared worktree for 'pair' and 'collaborative'.
 */
async function runCollaborativeTeam(
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
        selection.roleRequest.objective || `Collaborate on ${task.contract.objective}`,
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
  let implementerRes: Awaited<ReturnType<typeof executeGovernedAssignment>> | undefined;
  let worktree: { path: string; branchName?: string } | undefined;

  for (let i = 0; i < chain.length; i++) {
    const { selection, assignment } = chain[i];
    const label = i === 0 ? 'Lead' : 'Partner';

    if (i > 0 && ctx.communicationBus && lastRes) {
      await ctx.communicationBus
        .sendMessage({
          runId: ctx.runId,
          taskId: task.id,
          fromAssignmentId: chain[i - 1].assignment.id,
          toAssignmentId: assignment.id,
          type: 'handoff',
          body: `Handoff from ${chain[i - 1].selection.agent.name} (${chain[i - 1].selection.roleRequest.role}) to ${selection.agent.name} (${selection.roleRequest.role}):\n${lastRes.output ?? 'Completed step'}`,
        })
        .catch(() => {});
    }

    const res = await executeGovernedAssignment(
      buildGovernedCtx(task, ctx, assignment, selection.agent, headCommit, {
        objectiveOverride: i === 0 ? undefined : assignment.objective,
        existingWorktree: worktree,
      }),
    );

    outputs.push(
      `[${label} - ${selection.agent.name} (${selection.roleRequest.role})]:\n${
        res.output ?? (i === 0 ? 'Implemented' : 'Assisted and verified')
      }`,
    );
    lastRes = res;
    if (i === 0) {
      implementerRes = res;
    }

    if (!res.success) {
      for (const remaining of chain.slice(i + 1)) {
        ctx.assignmentRepo.updateStatus(remaining.assignment.id, 'cancelled');
      }
      return {
        success: false,
        output: outputs.join('\n\n'),
        worktreePath: implementerRes?.worktreePath ?? res.worktreePath,
      };
    }

    worktree = { path: res.worktreePath, branchName: assignment.branchName };
  }

  const finalWorktreePath = worktree?.path ?? implementerRes?.worktreePath ?? lastRes?.worktreePath;
  const finalCommit =
    lastRes?.commitHash ??
    (finalWorktreePath ? await ctx.gitService.getHeadCommit(finalWorktreePath) : undefined);

  let integrationCommit: string | undefined;
  let teamCommitCount = 0;

  // Represent the FULL cumulative delta (every team member's changes), not just
  // the last member's commit, as a single squash commit: same tree as the final
  // shared worktree HEAD, but parented directly on the task baseline. Cherry-picking
  // (or diffing against) that one commit then reproduces the entire team result.
  if (finalCommit && finalCommit !== headCommit && finalWorktreePath) {
    teamCommitCount = await ctx.gitService.countCommits(headCommit, finalCommit, finalWorktreePath);
    const treeHash = await ctx.gitService.getTreeHash(finalCommit, finalWorktreePath);
    const members = chain.map((s) => `${s.selection.agent.name} (${s.selection.roleRequest.role})`);
    integrationCommit = await ctx.gitService.commitTree(
      treeHash,
      headCommit,
      `chore(${task.id}): integrate cumulative team result\n\n${teamCommitCount} commit(s) by: ${members.join(' -> ')}`,
      finalWorktreePath,
    );

    ctx.eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId: ctx.runId,
      taskId: task.id,
      type: 'TEAM_CUMULATIVE_INTEGRATION',
      payload: {
        strategy: 'collaborative',
        baseCommit: headCommit,
        finalCommit,
        integrationCommit,
        teamCommitCount,
        members: chain.map((s) => ({ agentId: s.selection.agent.id, role: s.selection.roleRequest.role })),
      },
      timestamp: new Date(),
    });
  }

  return {
    success: true,
    commitHash: integrationCommit,
    integrationCommit,
    finalCommit,
    baseCommit: headCommit,
    teamCommitCount,
    worktreePath: finalWorktreePath,
    output: outputs.join('\n\n'),
  };
}

/**
 * Independent Review Strategy:
 * 1. Implementer runs and produces an implementation snapshot/commit.
 * 2. Reviewer(s) independently inspect that exact snapshot in isolated, read-only
 *    detached worktrees (detached: true). Reviewers cannot mutate the implementation.
 * 3. Review findings are gathered and deterministically evaluated:
 *    any critical/major findings fail the review and route the task back for rework.
 * 4. All reviewer worktrees are deterministically removed upon completion.
 */
async function runReviewTeam(
  task: Task,
  ctx: SchedulerContext,
  selected: SelectedAgentAssignment[],
): Promise<TeamExecutionResult> {
  const headCommit = ctx.baseCommit ?? (await ctx.gitService.getHeadCommit());
  const ordered = orderForStrategy('review', selected);
  const [lead, ...reviewers] = ordered;

  // 1. Run implementer
  const leadAssignment = buildAssignment(task, lead, task.contract.objective);
  ctx.assignmentRepo.create(leadAssignment, ctx.runId);

  ctx.onProgress?.(
    `[${task.id}] Review pipeline: implementer ${lead.agent.name} (${lead.roleRequest.role}) starting...`,
  );

  const implementerRes = await executeGovernedAssignment(
    buildGovernedCtx(task, ctx, leadAssignment, lead.agent, headCommit),
  );

  if (!implementerRes.success) {
    ctx.onProgress?.(`[${task.id}] Implementer ${lead.agent.name} failed; aborting review.`);
    return {
      success: false,
      output: implementerRes.output ?? implementerRes.message ?? 'Implementer failed',
      worktreePath: implementerRes.worktreePath,
    };
  }

  const gate = new CompletionGate(ctx.gitService);
  const gateRes = await gate.evaluate({
    task,
    assignment: leadAssignment,
    agentResult: {
      success: implementerRes.success,
      commitHash: implementerRes.commitHash,
      output: implementerRes.output,
      message: implementerRes.message ?? '',
      durationMs: implementerRes.durationMs,
      collaborationProposal: implementerRes.collaborationProposal,
      findings: implementerRes.findings,
      normalizedOutcome: implementerRes.normalizedOutcome,
      completionReason: implementerRes.completionReason,
    },
    normalizedOutcome: implementerRes.normalizedOutcome,
    baseCommit: headCommit,
    resultingCommit: implementerRes.commitHash,
    worktreePath: implementerRes.worktreePath,
    gitService: ctx.gitService,
  });

  if (!gateRes.accepted) {
    ctx.onProgress?.(
      `[${task.id}] Implementer ${lead.agent.name} failed completion gate: ${gateRes.evidence.explanation || gateRes.failureReason}`,
    );
    return {
      success: false,
      output:
        gateRes.evidence.explanation ??
        implementerRes.output ??
        'Implementer failed completion gate',
      worktreePath: implementerRes.worktreePath,
    };
  }

  const implCommit = implementerRes.commitHash ?? headCommit;

  // 2. Prepare reviewer assignments
  const reviewerChain = reviewers.map((rev) => ({
    selection: rev,
    assignment: buildAssignment(
      task,
      rev,
      rev.roleRequest.objective || `Review implementation against contract and safety criteria`,
      'pending' as const,
    ),
  }));

  for (const step of reviewerChain) {
    ctx.assignmentRepo.create(step.assignment, ctx.runId);
  }

  if (reviewerChain.length === 0) {
    return {
      success: true,
      commitHash: implCommit,
      worktreePath: implementerRes.worktreePath,
      output: implementerRes.output ?? 'Implemented',
    };
  }

  ctx.onProgress?.(
    `[${task.id}] Independent review: ${reviewerChain.length} reviewer(s) inspecting commit ${implCommit.slice(0, 7)}: ${reviewerChain
      .map((r) => `${r.selection.agent.name} (${r.selection.roleRequest.role})`)
      .join(', ')}`,
  );

  // Reserve concurrency capacity for all reviewers
  if (ctx.concurrency) {
    const reservations: TeamMemberReservation[] = reviewerChain.map((r) => ({
      taskId: task.id,
      assignmentId: r.assignment.id,
      agentId: r.selection.agent.id,
    }));
    const priority = computeTaskPriority(task, ctx.graph);
    await ctx.concurrency.waitForTeamSlots(reservations, ctx.abortSignal, priority, task.id);
  }

  // 3. Run all reviewers independently on the implementer's commit in detached worktrees
  const allFindings: ReviewFinding[] = [];
  const reviewerOutputs: string[] = [];
  let anyReviewerFailed = false;

  await Promise.all(
    reviewerChain.map(async ({ selection, assignment }) => {
      if (ctx.communicationBus) {
        await ctx.communicationBus
          .sendMessage({
            runId: ctx.runId,
            taskId: task.id,
            fromAssignmentId: leadAssignment.id,
            toAssignmentId: assignment.id,
            type: 'review',
            body: `Review requested for commit ${implCommit}: ${task.contract.objective}`,
          })
          .catch(() => {});
      }

      let res;
      try {
        res = await executeGovernedAssignment(
          buildGovernedCtx(task, ctx, assignment, selection.agent, implCommit, {
            objectiveOverride: assignment.objective,
            detached: true,
          }),
        );
      } finally {
        // Clean up reviewer detached worktree immediately after review finishes
        await ctx.worktreeManager
          .removeWorktree(task.id, assignment.id, true, true)
          .catch(() => {});
      }

      if (ctx.communicationBus) {
        await ctx.communicationBus
          .sendMessage({
            runId: ctx.runId,
            taskId: task.id,
            fromAssignmentId: assignment.id,
            toAssignmentId: leadAssignment.id,
            type: 'evidence',
            body: `[Reviewer ${selection.agent.name}]: ${res.output ?? res.message ?? (res.success ? 'Approved' : 'Rejected')}`,
          })
          .catch(() => {});
      }

      reviewerOutputs.push(
        `[Reviewer ${selection.agent.name} (${selection.roleRequest.role})]: ${res.output ?? res.message ?? (res.success ? 'Approved' : 'Failed')}`,
      );

      if (!res.success) {
        anyReviewerFailed = true;
      }
      if (res.findings && res.findings.length > 0) {
        allFindings.push(...res.findings);
      }
    }),
  );

  // 4. Deterministic evaluation of findings
  const criticalOrMajor = allFindings.filter(
    (f) => f.severity === 'critical' || f.severity === 'major',
  );

  if (anyReviewerFailed || criticalOrMajor.length > 0) {
    if (criticalOrMajor.length > 0 && ctx.activityTracker) {
      ctx.activityTracker.setCriticalFindings(leadAssignment.id, criticalOrMajor);
    }

    const findingSummary =
      criticalOrMajor.length > 0
        ? `\nCritical/Major findings:\n${criticalOrMajor.map((f) => `- [${f.severity.toUpperCase()}] ${f.file ? `${f.file}${f.line !== undefined ? `:${f.line}` : ''} ` : ''}${f.description}`).join('\n')}`
        : '';

    ctx.onProgress?.(
      `[${task.id}] ✗ Review rejected: ${criticalOrMajor.length} blocking finding(s), reviewer failure: ${anyReviewerFailed}`,
    );

    for (const f of criticalOrMajor) {
      const loc = f.file ? ` at ${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : '';
      ctx.onProgress?.(`[${task.id}] ✖ [${f.severity.toUpperCase()}]${loc}: ${f.description}`);
    }

    return {
      success: false,
      commitHash: implCommit,
      worktreePath: implementerRes.worktreePath,
      findings: allFindings,
      output: `Review rejected:${findingSummary}\n\nReviewer logs:\n${reviewerOutputs.join('\n')}`,
    };
  }

  ctx.onProgress?.(`[${task.id}] ✓ Review approved by all ${reviewerChain.length} reviewer(s).`);

  return {
    success: true,
    commitHash: implCommit,
    worktreePath: implementerRes.worktreePath,
    findings: allFindings,
    output: `Implementation and review complete.\nImplementer: ${implementerRes.output ?? 'Done'}\n\n${reviewerOutputs.join('\n')}`,
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
  const maxAgents = ctx.config.collaboration?.maxAgentsPerTask ?? 3;

  // A task only needs a mutating "implementer" step if its completion policy
  // actually requires a code change (see resolveCompletionPolicy). Investigation
  // and report-only tasks must never silently gain an implementation step just
  // because a 'parallel' team was staffed without an explicit implementer role.
  const requiresCodeChange = resolveCompletionPolicy(task).requirement === 'code_change_required';
  const explicitImplementer = selected.find((s) => s.roleRequest.role === 'implementer');

  if (requiresCodeChange && !explicitImplementer) {
    ctx.eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId: ctx.runId,
      taskId: task.id,
      type: 'ROUTING_INVALID_FOR_TASK',
      payload: {
        taskId: task.id,
        reason: 'Task requires a code change but routing did not staff an implementer role.',
        staffedRoles: selected.map((s) => s.roleRequest.role),
      },
      timestamp: new Date(),
    });
    ctx.onProgress?.(
      `[${task.id}] ✕ Routing invalid: task requires implementation but no 'implementer' role was staffed (staffed: ${
        selected.map((s) => s.roleRequest.role).join(', ') || 'none'
      }).`,
    );
    return {
      success: false,
      output: `Routing invalid for task: implementation is required but no implementer role was staffed by routing (staffed roles: ${
        selected.map((s) => s.roleRequest.role).join(', ') || 'none'
      }).`,
    };
  }

  // For investigation-only tasks nobody is "promoted" to implementer: every
  // selected agent investigates, and the synthesis-graph bookkeeping identity
  // (never executed as a mutating assignment below) borrows the first agent's
  // id purely to label the synthesis node.
  const implementer = requiresCodeChange ? explicitImplementer! : (explicitImplementer ?? selected[0]);
  const investigators = requiresCodeChange ? selected.filter((s) => s !== implementer) : selected;

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
    undefined,
    maxAgents,
  );

  for (const node of asgnGraph.getAllNodes()) {
    ctx.assignmentRepo.create(node.assignment, ctx.runId);
  }

  if (ctx.communicationBus && routing.communication?.initialAlignment) {
    await ctx.communicationBus
      .sendMessage({
        runId: ctx.runId,
        taskId: task.id,
        fromAssignmentId: `asgn-${task.id}-lead`,
        toAssignmentId: undefined,
        type: 'proposal',
        body: `Initial alignment for parallel investigation: ${task.contract.objective}`,
      })
      .catch(() => {});
  }

  const completed = new Set<string>();
  const outputs: Array<{ role: string; agentId: string; output: string }> = [];

  interface RoleOutcome {
    role: string;
    satisfied: boolean;
    reason?: string;
    attempts: number;
  }
  const roleOutcomes: RoleOutcome[] = [];

  // Original RoleRequest (capabilities/objective/preferredAgent) per
  // investigator, keyed by the agent+role it was originally staffed with --
  // needed to find a same-role replacement if that agent turns out to be
  // unavailable mid-run.
  const roleRequestByAgentAndRole = new Map<string, RoleRequest>();
  for (const inv of investigators) {
    roleRequestByAgentAndRole.set(`${inv.agent.id}::${inv.roleRequest.role}`, inv.roleRequest);
  }
  const agentSelector = new AgentSelector(ctx.agentRegistry);
  const quotaTracker = AgentQuotaTracker.getInstance();

  const runnable = asgnGraph.getRunnableAssignments(completed);
  if (ctx.concurrency && runnable.length > 0) {
    const reservations: TeamMemberReservation[] = runnable.map((a) => ({
      taskId: task.id,
      assignmentId: a.id,
      agentId: a.agentId,
    }));
    const priority = computeTaskPriority(task, ctx.graph);
    await ctx.concurrency.waitForTeamSlots(reservations, ctx.abortSignal, priority, task.id);
  }

  await Promise.all(
    runnable.map(async (asgn) => {
      const roleRequest = roleRequestByAgentAndRole.get(`${asgn.agentId}::${asgn.role}`);
      const triedAgentIds = new Set<string>([asgn.agentId]);
      let attempt = 1;
      let currentAssignment: AgentAssignment = asgn;
      let currentAgent = ctx.agentRegistry.get(asgn.agentId)!;
      let lastFailure:
        | { agentId: string; agentName: string; reason?: string; resetAt?: string }
        | undefined;

      for (;;) {
        const res = await executeGovernedAssignment(
          buildGovernedCtx(task, ctx, currentAssignment, currentAgent, headCommit, { detached: true }),
        );
        completed.add(currentAssignment.id);

        // Clean up investigator's temporary worktree immediately
        await ctx.worktreeManager
          .removeWorktree(task.id, currentAssignment.id, true, true)
          .catch(() => {});

        if (res.success) {
          outputs.push({ role: asgn.role, agentId: currentAgent.id, output: res.output ?? 'Done' });
          roleOutcomes.push({ role: asgn.role, satisfied: true, attempts: attempt });

          if (attempt > 1) {
            ctx.onProgress?.(`[${task.id}] ✓ ${asgn.role} role recovered with ${currentAgent.name}`);
            const failed = lastFailure ?? {
              agentId: asgn.agentId,
              agentName: asgn.agentId,
            };
            ctx.activityTracker?.markRecovered(currentAssignment.id, {
              failedAgentId: failed.agentId,
              failedAgentName: failed.agentName,
              reason: failed.reason,
              resetAt: failed.resetAt,
            });
            ctx.streamBus?.publish({
              type: 'investigator_failover',
              stage: 'recovered',
              timestamp: new Date(),
              runId: ctx.runId,
              taskId: task.id,
              assignmentId: currentAssignment.id,
              agentId: currentAgent.id,
              role: asgn.role,
              failedAgentId: failed.agentId,
              failedAgentName: failed.agentName,
              replacementAgentId: currentAgent.id,
              replacementAgentName: currentAgent.name,
              reason: failed.reason,
              resetAt: failed.resetAt,
            });
            ctx.eventRepo.append({
              id: `evt-${randomUUID()}`,
              runId: ctx.runId,
              taskId: task.id,
              type: 'INVESTIGATOR_REASSIGNED',
              payload: {
                taskId: task.id,
                role: asgn.role,
                failedAgentId: failed.agentId,
                failedAgentName: failed.agentName,
                replacementAgentId: currentAgent.id,
                replacementAgentName: currentAgent.name,
                reason: failed.reason,
                resetAt: failed.resetAt,
                attempt,
                investigationPolicy: policy,
              },
              timestamp: new Date(),
            });
          }

          if (ctx.communicationBus) {
            await ctx.communicationBus
              .sendMessage({
                runId: ctx.runId,
                taskId: task.id,
                fromAssignmentId: currentAssignment.id,
                toAssignmentId: undefined,
                type: 'evidence',
                body: `[${asgn.role} by ${currentAgent.id}]: ${res.output ?? 'Done'}`,
              })
              .catch(() => {});
          }
          return;
        }

        const cancelled = Boolean(ctx.abortSignal?.aborted);
        const failureClass = classifyTeamMemberFailure(res.completionReason, cancelled);
        const reason = res.message || res.output || 'Execution failed';

        if (failureClass !== 'provider_unavailable') {
          // Semantic/permission/cancellation failure: the work itself did
          // not succeed. This role stays unsatisfied and is subject to the
          // investigation policy like any other failure -- never auto-retried.
          roleOutcomes.push({ role: asgn.role, satisfied: false, reason, attempts: attempt });
          return;
        }

        // Recoverable provider/capacity failure: announce it, then try to
        // find a distinct healthy agent for the SAME role. Bounded: every
        // eligible agent is tried at most once per role (triedAgentIds only
        // grows), so this can never loop forever.
        const quotaInfo = quotaTracker.getQuotaStatus(currentAgent.id);
        const quotaNote = quotaInfo.reason
          ? `${quotaInfo.reason}${quotaInfo.resetAt ? ` (resets ${quotaInfo.resetAt.toISOString()})` : ''}`
          : reason;
        const failedAgentId = currentAgent.id;
        const failedAgentName = currentAgent.name;
        const resetAt = quotaInfo.resetAt?.toISOString();
        lastFailure = {
          agentId: failedAgentId,
          agentName: failedAgentName,
          reason: quotaNote,
          resetAt,
        };
        ctx.onProgress?.(`[${task.id}] ⚠ ${currentAgent.name} unavailable for ${asgn.role}: ${quotaNote}`);
        ctx.streamBus?.publish({
          type: 'investigator_failover',
          stage: 'provider_failed',
          timestamp: new Date(),
          runId: ctx.runId,
          taskId: task.id,
          assignmentId: currentAssignment.id,
          agentId: currentAgent.id,
          role: asgn.role,
          failedAgentId,
          failedAgentName,
          reason: quotaNote,
          resetAt,
        });
        ctx.eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId: ctx.runId,
          taskId: task.id,
          type: 'INVESTIGATOR_FAILED',
          payload: {
            taskId: task.id,
            role: asgn.role,
            failedAgentId,
            failedAgentName,
            failureReason: res.completionReason ?? 'UNKNOWN',
            reason: quotaNote,
            resetAt,
            attempt,
            investigationPolicy: policy,
          },
          timestamp: new Date(),
        });

        if (!roleRequest) {
          roleOutcomes.push({ role: asgn.role, satisfied: false, reason: quotaNote, attempts: attempt });
          return;
        }

        const replacement = await agentSelector.selectAgentForRole(roleRequest, {
          excludeAgentIds: triedAgentIds,
          selectionKey: `${ctx.repoRoot}:${task.id}:failover:${asgn.role}`,
        });

        if (!replacement) {
          const triedList = Array.from(triedAgentIds).join(', ');
          ctx.onProgress?.(
            `[${task.id}] ✕ Investigation role '${asgn.role}' could not be satisfied. Tried: ${triedList}. Reason: no healthy eligible agents remain. Policy: ${policy}.`,
          );
          ctx.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId: ctx.runId,
            taskId: task.id,
            type: 'INVESTIGATOR_CAPACITY_EXHAUSTED',
            payload: {
              taskId: task.id,
              role: asgn.role,
              triedAgentIds: Array.from(triedAgentIds),
              investigationPolicy: policy,
            },
            timestamp: new Date(),
          });
          roleOutcomes.push({
            role: asgn.role,
            satisfied: false,
            reason: `no healthy eligible agents remain (tried: ${triedList})`,
            attempts: attempt,
          });
          return;
        }

        ctx.onProgress?.(`[${task.id}] ↻ Reassigning ${asgn.role} → ${replacement.agent.name}`);
        ctx.streamBus?.publish({
          type: 'investigator_failover',
          stage: 'reassigning',
          timestamp: new Date(),
          runId: ctx.runId,
          taskId: task.id,
          assignmentId: currentAssignment.id,
          agentId: currentAgent.id,
          role: asgn.role,
          failedAgentId,
          failedAgentName,
          replacementAgentId: replacement.agent.id,
          replacementAgentName: replacement.agent.name,
          reason: quotaNote,
          resetAt,
        });

        triedAgentIds.add(replacement.agent.id);
        attempt += 1;
        currentAgent = replacement.agent;
        currentAssignment = {
          id: `asgn-${task.id}-${asgn.role}-retry-${randomUUID().slice(0, 8)}`,
          taskId: task.id,
          agentId: replacement.agent.id,
          role: asgn.role,
          objective: roleRequest.objective,
          status: 'pending',
        };
        ctx.assignmentRepo.create(currentAssignment, ctx.runId);
      }
    }),
  );

  const investigatorCount = roleOutcomes.length;
  const unsatisfiedRoles = roleOutcomes.filter((r) => !r.satisfied);
  const satisfiedRoles = roleOutcomes.filter((r) => r.satisfied);
  const failureRatio = investigatorCount > 0 ? unsatisfiedRoles.length / investigatorCount : 0;

  let policyViolated: boolean;
  if (investigatorCount > 0 && satisfiedRoles.length === 0) {
    // Nothing was produced at all -- nothing to synthesize, regardless of policy.
    policyViolated = true;
  } else {
    switch (policy) {
      case 'quorum':
        policyViolated = failureRatio >= 0.5;
        break;
      case 'best_effort':
        policyViolated = false;
        break;
      case 'all_required':
      default:
        policyViolated = unsatisfiedRoles.length > 0;
        break;
    }
  }

  if (policyViolated) {
    const detailMsg =
      unsatisfiedRoles.length > 0
        ? ` Reason: ${unsatisfiedRoles.map((r) => `${r.role}: ${r.reason}`).join('; ')}`
        : '';
    ctx.onProgress?.(
      `[${task.id}] Investigation phase failed under '${policy}' policy: ${unsatisfiedRoles.length}/${investigatorCount} roles unsatisfied.${detailMsg}`,
    );
    return {
      success: false,
      output: `Investigation phase failed under '${policy}' policy (${unsatisfiedRoles.length}/${investigatorCount} roles unsatisfied)${detailMsg}`,
    };
  }

  if (unsatisfiedRoles.length > 0) {
    ctx.onProgress?.(
      `[${task.id}] Proceeding with degraded investigation: ${unsatisfiedRoles.length}/${investigatorCount} role(s) unsatisfied (${unsatisfiedRoles
        .map((r) => r.role)
        .join(', ')}); policy '${policy}' allows continuing.`,
    );
    ctx.eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId: ctx.runId,
      taskId: task.id,
      type: 'INVESTIGATION_DEGRADED',
      payload: {
        taskId: task.id,
        investigationPolicy: policy,
        unsatisfiedRoles: unsatisfiedRoles.map((r) => ({ role: r.role, reason: r.reason })),
      },
      timestamp: new Date(),
    });
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

    if (ctx.communicationBus) {
      await ctx.communicationBus
        .sendMessage({
          runId: ctx.runId,
          taskId: task.id,
          fromAssignmentId: synthesisNode.id,
          toAssignmentId: undefined,
          type: 'proposal',
          body: synthesized.recommendedFix,
        })
        .catch(() => {});
    }
  } else if (synthesisNodes.length > 0) {
    ctx.assignmentRepo.updateStatus(synthesisNodes[0].id, 'cancelled');
    completed.add(synthesisNodes[0].id);
  }

  if (!requiresCodeChange) {
    // Investigation/report-only task: the synthesis node is bookkeeping only.
    // Never execute a mutating governed assignment for it -- the repository
    // must stay untouched, and the task's result is the synthesized report.
    for (const node of asgnGraph.getRunnableAssignments(completed)) {
      ctx.assignmentRepo.updateStatus(node.id, 'cancelled');
      completed.add(node.id);
    }
    const report =
      outputs.length > 0
        ? outputs.map((o) => `[${o.role} - ${o.agentId}]\n${o.output}`).join('\n\n')
        : 'Investigation produced no substantive findings.';
    return {
      success: true,
      output: report,
    };
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
 * best one wins. Losing worktrees are removed immediately.
 */
async function runCompetitiveTeam(
  task: Task,
  ctx: SchedulerContext,
  selected: SelectedAgentAssignment[],
): Promise<TeamExecutionResult> {
  const headCommit = ctx.baseCommit ?? (await ctx.gitService.getHeadCommit());

  const candidates = selected.map((selection) => ({
    selection,
    assignment: buildAssignment(
      task,
      selection,
      selection.roleRequest.objective || task.contract.objective,
    ),
  }));

  for (const candidate of candidates) {
    ctx.assignmentRepo.create(candidate.assignment, ctx.runId);
  }

  ctx.onProgress?.(
    `[${task.id}] Competitive: ${candidates.length} independent solutions from ${candidates
      .map((c) => c.selection.agent.name)
      .join(', ')}`,
  );

  if (ctx.concurrency && candidates.length > 0) {
    const reservations: TeamMemberReservation[] = candidates.map((c) => ({
      taskId: task.id,
      assignmentId: c.assignment.id,
      agentId: c.selection.agent.id,
    }));
    const priority = computeTaskPriority(task, ctx.graph);
    await ctx.concurrency.waitForTeamSlots(reservations, ctx.abortSignal, priority, task.id);
  }

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
    // Clean up all failed candidate worktrees and branches
    for (const candidate of attempts) {
      await ctx.worktreeManager
        .removeWorktree(task.id, candidate.assignment.id, true, true)
        .catch(() => {});
    }
    return {
      success: false,
      output: `All ${attempts.length} competing solutions failed:\n${attempts
        .map(
          (a) => `[${a.selection.agent.name}]: ${a.result.output ?? a.result.message ?? 'failed'}`,
        )
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
          .catch((): VerificationResult => ({
            passed: false,
            checks: [],
            failureReason: 'verification threw while evaluating competing solution',
          })),
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

  // Deterministically clean up all non-winning candidate worktrees and branches
  for (const candidate of attempts) {
    if (candidate.assignment.id !== winner.assignment.id) {
      await ctx.worktreeManager
        .removeWorktree(task.id, candidate.assignment.id, true, true)
        .catch(() => {});
    }
  }

  if (ctx.communicationBus) {
    await ctx.communicationBus
      .sendMessage({
        runId: ctx.runId,
        taskId: task.id,
        fromAssignmentId: winner.assignment.id,
        toAssignmentId: undefined,
        type: 'proposal',
        body: `Competitive solution selected: ${winner.selection.agent.name}`,
      })
      .catch(() => {});
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
    id: `asgn-${task.id}-${randomUUID().slice(0, 8)}`,
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
    originalUserRequest: ctx.originalUserRequest,
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
    streamBus: ctx.streamBus,
    concurrency: ctx.concurrency,
    graph: ctx.graph,
    priority: computeTaskPriority(task, ctx.graph),
    communicationBus: ctx.communicationBus,
    sessionRegistry: ctx.sessionRegistry,
    abortSignal: ctx.abortSignal,
    onUsage: (usage: import('@taskforge/shared').AgentUsage) => {
      ctx.onAgentUsage?.({
        task,
        assignment,
        agentId: agent.id,
        usage,
      });
    },
    ...overrides,
  };
}
