import { randomUUID } from 'node:crypto';
import { AgentAssignment, VerificationResult, ReviewFinding } from '@taskforge/shared';
import { Task, computeTaskPriority } from '@taskforge/core';
import { AgentAdapter } from '@taskforge/agents';
import { AssignmentGraph, SynthesisCoordinator } from '@taskforge/collaboration';
import { AgentSelector, RoutingDecision, SelectedAgentAssignment } from '@taskforge/router';
import { executeGovernedAssignment } from './governed-assignment.js';
import { SchedulerContext } from './deterministic-scheduler.js';
import { TeamMemberReservation } from './concurrency-manager.js';
import { CompletionGate } from './completion-gate.js';

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
      ctx.activityTracker.setCriticalFindings(task.id, criticalOrMajor);
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
  const unresolvedInvestigators: string[] = [];
  const failedDetails: Array<{ id: string; agentId: string; role: string; reason: string }> = [];
  const selector = new AgentSelector(ctx.agentRegistry);

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
    runnable.map(async (slotAssignment) => {
      const originalSelection =
        investigators.find(
          (inv) =>
            inv.agent.id === slotAssignment.agentId &&
            inv.roleRequest.role === slotAssignment.role,
        ) ??
        investigators.find((inv) => inv.roleRequest.role === slotAssignment.role);

      const roleRequest = originalSelection?.roleRequest ?? {
        role: slotAssignment.role,
        requiredCapabilities: ['canRead'],
        objective: slotAssignment.objective,
      };

      const attemptedAgentIds = new Set<string>();
      let currentAssignment = slotAssignment;
      let currentAgent = ctx.agentRegistry.get(currentAssignment.agentId);
      let lastReason = 'Execution failed';

      while (currentAgent && !attemptedAgentIds.has(currentAgent.id)) {
        attemptedAgentIds.add(currentAgent.id);

        const res = await executeGovernedAssignment(
          buildGovernedCtx(task, ctx, currentAssignment, currentAgent, headCommit, {
            detached: true,
          }),
        );

        // Every attempt owns a temporary detached worktree.
        await ctx.worktreeManager
          .removeWorktree(task.id, currentAssignment.id, true, true)
          .catch(() => {});

        if (res.success) {
          // The assignment graph represents logical investigation slots. Once a
          // replacement satisfies the slot, mark the ORIGINAL graph node complete
          // so synthesis can become runnable while keeping the failed attempt
          // persisted as failed for auditability.
          completed.add(slotAssignment.id);
          outputs.push({
            role: slotAssignment.role,
            agentId: currentAgent.id,
            output: res.output ?? 'Done',
          });

          if (currentAssignment.id !== slotAssignment.id) {
            ctx.onProgress?.(
              `[${task.id}] ✓ Investigator role '${slotAssignment.role}' recovered with ${currentAgent.name}.`,
            );
            ctx.eventRepo.append({
              id: `evt-${randomUUID()}`,
              runId: ctx.runId,
              taskId: task.id,
              type: 'INVESTIGATOR_REASSIGNED',
              payload: {
                role: slotAssignment.role,
                replacementAgentId: currentAgent.id,
                replacementAssignmentId: currentAssignment.id,
                originalAssignmentId: slotAssignment.id,
                investigationPolicy: policy,
                attempt: attemptedAgentIds.size,
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
                body: `[${slotAssignment.role} by ${currentAgent.id}]: ${res.output ?? 'Done'}`,
              })
              .catch(() => {});
          }
          return;
        }

        lastReason = res.message || res.output || 'Execution failed';
        const recoverableProviderFailure = res.completionReason === 'PROVIDER_QUOTA_EXCEEDED';

        ctx.eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId: ctx.runId,
          taskId: task.id,
          type: 'INVESTIGATOR_FAILED',
          payload: {
            role: slotAssignment.role,
            agentId: currentAgent.id,
            assignmentId: currentAssignment.id,
            failureReason: res.completionReason ?? 'UNKNOWN',
            message: lastReason,
            recoverableProviderFailure,
            investigationPolicy: policy,
            attempt: attemptedAgentIds.size,
          },
          timestamp: new Date(),
        });

        if (!recoverableProviderFailure) {
          // Semantic/task failures remain subject to the configured investigation
          // policy; do not hide them behind blind provider failover.
          break;
        }

        ctx.onProgress?.(
          `[${task.id}] ⚠ ${currentAgent.name} unavailable for ${slotAssignment.role}: ${lastReason}`,
        );

        const replacement = await selector.selectAgentForRole(roleRequest, {
          excludeAgentIds: attemptedAgentIds,
        });

        if (!replacement) {
          ctx.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId: ctx.runId,
            taskId: task.id,
            type: 'INVESTIGATOR_CAPACITY_EXHAUSTED',
            payload: {
              role: slotAssignment.role,
              attemptedAgentIds: [...attemptedAgentIds],
              investigationPolicy: policy,
              reason: lastReason,
            },
            timestamp: new Date(),
          });
          break;
        }

        const replacementAssignment = buildAssignment(
          task,
          replacement,
          roleRequest.objective || slotAssignment.objective,
        );
        ctx.assignmentRepo.create(replacementAssignment, ctx.runId);

        ctx.onProgress?.(
          `[${task.id}] ↻ Reassigning ${slotAssignment.role}: ${currentAgent.name} → ${replacement.agent.name}`,
        );
        ctx.eventRepo.append({
          id: `evt-${randomUUID()}`,
          runId: ctx.runId,
          taskId: task.id,
          type: 'INVESTIGATOR_REASSIGNMENT',
          payload: {
            role: slotAssignment.role,
            failedAgentId: currentAgent.id,
            failedAssignmentId: currentAssignment.id,
            replacementAgentId: replacement.agent.id,
            replacementAssignmentId: replacementAssignment.id,
            failureReason: res.completionReason,
            investigationPolicy: policy,
            attempt: attemptedAgentIds.size + 1,
          },
          timestamp: new Date(),
        });

        currentAssignment = replacementAssignment;
        currentAgent = replacement.agent;
      }

      unresolvedInvestigators.push(slotAssignment.id);
      failedDetails.push({
        id: slotAssignment.id,
        agentId: currentAgent?.id ?? slotAssignment.agentId,
        role: slotAssignment.role,
        reason: lastReason,
      });
      completed.add(slotAssignment.id);
    }),
  );

  const investigatorCount = runnable.length;
  const unresolvedRatio =
    investigatorCount > 0 ? unresolvedInvestigators.length / investigatorCount : 0;

  const policyViolated =
    unresolvedInvestigators.length > 0 &&
    (policy === 'all_required' || (policy === 'quorum' && unresolvedRatio >= 0.5));

  if (policyViolated) {
    const detailMsg =
      failedDetails.length > 0
        ? ` Reason: ${failedDetails.map((d) => `${d.agentId} (${d.role}): ${d.reason}`).join('; ')}`
        : '';
    ctx.onProgress?.(
      `[${task.id}] Investigation phase failed under '${policy}' policy: ${unresolvedInvestigators.length}/${investigatorCount} roles unsatisfied.${detailMsg}`,
    );
    return {
      success: false,
      output: `Investigation phase failed under '${policy}' policy (${unresolvedInvestigators.length}/${investigatorCount} roles unsatisfied)${detailMsg}`,
    };
  }

  if (unresolvedInvestigators.length > 0) {
    ctx.onProgress?.(
      `[${task.id}] ⚠ Investigation continuing under '${policy}' with ${unresolvedInvestigators.length}/${investigatorCount} role(s) unsatisfied.`,
    );
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
    concurrency: ctx.concurrency,
    graph: ctx.graph,
    priority: computeTaskPriority(task, ctx.graph),
    communicationBus: ctx.communicationBus,
    sessionRegistry: ctx.sessionRegistry,
    abortSignal: ctx.abortSignal,
    ...overrides,
  };
}
