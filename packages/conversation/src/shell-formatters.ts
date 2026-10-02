import { ActiveAgentState } from '@taskforge/shared';
import { AgentRegistry } from '@taskforge/agents';
import { GitService } from '@taskforge/workspace';
import { OrchestrationResult, sanitizeTaskOutput } from '@taskforge/scheduler';
import {
  TaskForgeDatabase,
  RunRepository,
  GoalRepository,
  EventRepository,
  TaskRepository,
  AssignmentRepository,
  AuditService,
} from '@taskforge/persistence';
import { TelemetryCollector, RunUsageEstimate } from '@taskforge/telemetry';
import { DeliveryService } from '@taskforge/integration';
import { theme, colors } from './theme.js';
import { LiveTicker } from './live-ticker.js';
import { formatApproxTokens, sanitizeDisplayedRepositoryPaths } from './shell-helpers.js';

export interface RunInspectionContext {
  activeRunId?: string;
  agentRegistry: AgentRegistry;
  assignmentRepo: AssignmentRepository;
  db: TaskForgeDatabase;
  deliveryService: DeliveryService;
  eventRepo: EventRepository;
  taskRepo: TaskRepository;
}

export interface RunDiffContext {
  deliveryService: DeliveryService;
  gitService: GitService;
  repoRoot: string;
}

export interface RunSummaryContext {
  deliveryService: DeliveryService;
  repoRoot: string;
  telemetry: TelemetryCollector;
}

/**
 * Live /tasks view (Part 21): every active assignment grouped by task,
 * showing agent, role, running duration and current activity -- the same
 * identity model the activity tracker and cockpit tabs use, so this stays
 * consistent with /stream and the ticker rather than a third data source.
 */
export function formatActiveTasksView(active: ActiveAgentState[], filterTaskId?: string): string {
  const scoped = filterTaskId
    ? active.filter((a) => a.taskId.toLowerCase() === filterTaskId.toLowerCase())
    : active;
  if (scoped.length === 0) {
    return `No active agents for task ${filterTaskId}.`;
  }

  const byTask = new Map<string, ActiveAgentState[]>();
  for (const a of scoped) {
    const list = byTask.get(a.taskId) ?? [];
    list.push(a);
    byTask.set(a.taskId, list);
  }

  const lines: string[] = [`${colors.brand}✦ ${colors.bold}Active Tasks${colors.reset}`, ''];
  for (const [taskId, assignments] of byTask) {
    lines.push(`${colors.bold}${taskId}${colors.reset}  ${assignments[0].taskTitle}`, '');
    for (const [idx, a] of assignments.entries()) {
      const agentColor = LiveTicker.getAgentColor(a.agentId);
      const duration = LiveTicker.formatDuration(a.startedAt);
      const statusIcon = a.attentionRequired
        ? `${colors.yellow}▲${colors.reset}`
        : `${colors.green}●${colors.reset}`;
      lines.push(
        `  ${colors.dim}[${idx + 1}]${colors.reset} ${agentColor}${a.agentName}${colors.reset}`,
        `      ${colors.dim}${a.role}${colors.reset}`,
        `      ${statusIcon} Running · ${duration}`,
        `      ${a.status}`,
        '',
      );
    }
  }
  return lines.join('\n').trimEnd();
}

/**
 * Completed-run review (Parts 14/22): the full Run -> Task -> Assignment
 * hierarchy, including intent normalization, routing-invalid and
 * mutation-blocked events that happened along the way -- the "what
 * actually happened" view once /stream's live agents are gone.
 */
export function formatRunInspection(ctx: RunInspectionContext, runIdArg?: string): string {
  const runId = runIdArg ?? ctx.activeRunId ?? new RunRepository(ctx.db).listAll()[0]?.id;
  if (!runId) {
    return 'No runs recorded yet.';
  }

  const goalRepo = new GoalRepository(ctx.db);
  const audit = new AuditService(new RunRepository(ctx.db), goalRepo, ctx.taskRepo, ctx.eventRepo).reconstructRun(
    runId,
  );
  if (!audit) {
    return `No run found with id ${runId}. Use /runs to see recorded runs.`;
  }

  const { run, goal, tasks, events } = audit;
  const assignments = ctx.assignmentRepo.listByRun(runId);
  const delivery = ctx.deliveryService.getDelivery(runId);

  const lines: string[] = [
    `${colors.brand}✦ ${colors.bold}RUN ${run.id}${colors.reset}`,
    `  ${colors.dim}Status:${colors.reset} ${theme.statusBadge(run.status)}`,
  ];
  if (goal) {
    lines.push(`  ${colors.dim}Goal:${colors.reset}   ${goal.description}`);
  }
  if (delivery) {
    lines.push(`  ${colors.dim}Delivery:${colors.reset} ${delivery.status.toUpperCase()}`);
  }
  lines.push('');

  const normalizationEvents = events.filter((e) => e.type === 'PLAN_INTENT_NORMALIZED');
  const routingInvalidEvents = events.filter((e) => e.type === 'ROUTING_INVALID_FOR_TASK');
  const mutationBlockedEvents = events.filter((e) => e.type === 'MUTATION_BLOCKED');
  const reassignmentEvents = events.filter(
    (e) => e.type === 'INVESTIGATOR_REASSIGNED' || e.type === 'INVESTIGATOR_FAILED',
  );

  for (const task of tasks) {
    lines.push(`${colors.bold}${task.id}${colors.reset}  ${task.title}`);
    lines.push(`  ${colors.dim}Type:${colors.reset} ${task.type}   ${theme.statusBadge(task.status)}`);

    const taskNormalizations = normalizationEvents.filter((e) => e.taskId === task.id);
    for (const e of taskNormalizations) {
      const p = e.payload as { originalTaskType?: string; normalizedTaskType?: string; reason?: string };
      lines.push(
        `  ${colors.yellow}⚠ Intent normalized:${colors.reset} ${p.originalTaskType} → ${p.normalizedTaskType}`,
      );
    }
    for (const e of routingInvalidEvents.filter((ev) => ev.taskId === task.id)) {
      const p = e.payload as { reason?: string };
      lines.push(`  ${colors.red}✕ Routing invalid:${colors.reset} ${p.reason ?? ''}`);
    }
    for (const e of mutationBlockedEvents.filter((ev) => ev.taskId === task.id)) {
      const p = e.payload as { uncommittedFiles?: string[]; blockedCommit?: string };
      const detail = p.blockedCommit
        ? `reverted commit ${p.blockedCommit.slice(0, 7)}`
        : `reverted ${p.uncommittedFiles?.length ?? 'an'} unauthorized change(s)`;
      lines.push(`  ${colors.yellow}▲ Mutation blocked:${colors.reset} ${detail}`);
    }
    for (const e of reassignmentEvents.filter((ev) => ev.taskId === task.id)) {
      const p = e.payload as { role?: string; failedAgentId?: string; replacementAgentId?: string };
      if (e.type === 'INVESTIGATOR_REASSIGNED' && p.replacementAgentId) {
        lines.push(`  ${colors.cyan}↻ Reassigned${colors.reset} ${p.role}: ${p.failedAgentId} → ${p.replacementAgentId}`);
      } else if (e.type === 'INVESTIGATOR_FAILED') {
        lines.push(`  ${colors.yellow}⚠ Provider unavailable${colors.reset} for ${p.role} (${p.failedAgentId})`);
      }
    }

    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    if (taskAssignments.length > 0) {
      lines.push(`  ${colors.dim}Assignments${colors.reset}`);
      for (const a of taskAssignments) {
        const agentName = ctx.agentRegistry.get(a.agentId)?.name ?? a.agentId;
        const badge = theme.statusBadge(a.status);
        const reason = a.completionReason ? ` ${colors.dim}(${a.completionReason})${colors.reset}` : '';
        lines.push(`    ${colors.dim}${a.id}${colors.reset}  ${agentName}  ${a.role}  ${badge}${reason}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Summary-first diff view (Part 20): total files/insertions/deletions up
 * top, then a per-file M/A/D list. Never dumps a full unified diff
 * automatically -- that stays an explicit, separate escape hatch.
 */
export async function formatRunDiff(ctx: RunDiffContext, runId: string): Promise<string> {
  const delivery = ctx.deliveryService.getDelivery(runId);
  if (!delivery) {
    return `Run ${runId} has no delivery information.`;
  }

  const stat = await ctx.deliveryService.diff(runId);
  if (!stat.trim()) {
    return `${colors.brand}✦ ${colors.bold}Run Diff${colors.reset}\n\n  No changes to show.`;
  }

  const summaryMatch = stat.match(
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
  );
  const filesChanged = summaryMatch?.[1] ?? '0';
  const insertions = summaryMatch?.[2] ?? '0';
  const deletions = summaryMatch?.[3] ?? '0';

  let fileLines: string[] = [];
  try {
    const nameStatus = await ctx.gitService.exec(
      ['diff', '--name-status', `${delivery.targetBranch}...${delivery.branch}`],
      ctx.repoRoot,
    );
    fileLines = nameStatus
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split(/\s+/);
        return `  ${status[0]} ${rest.join(' ')}`;
      });
  } catch {
    // fall back to the --stat file list (no M/A/D prefix) if name-status fails
    fileLines = stat
      .split('\n')
      .filter((l) => l.includes('|'))
      .map((l) => `  ${l.split('|')[0].trim()}`);
  }

  return [
    `${colors.brand}✦ ${colors.bold}Run Diff${colors.reset}`,
    '',
    `  ${colors.bold}${filesChanged}${colors.reset} file${filesChanged === '1' ? '' : 's'} changed`,
    `  ${colors.green}+${insertions}${colors.reset}  ${colors.red}-${deletions}${colors.reset}`,
    '',
    ...fileLines,
  ].join('\n');
}

export async function formatRunSummary(ctx: RunSummaryContext, result: OrchestrationResult): Promise<string> {
  const statusColor =
    result.status === 'completed'
      ? colors.green
      : result.status === 'cancelled'
        ? colors.yellow
        : colors.red;

  const outputs = Object.entries(result.taskOutputs ?? {})
    .filter(([, text]) => text && text.trim().length > 0)
    .map(([taskId, text]) => {
      const header =
        result.status === 'completed'
          ? `Explanation & Analysis [${taskId}]`
          : `Last Attempt Output — NOT VERIFIED / NOT DELIVERED [${taskId}]`;
      const sanitized = sanitizeDisplayedRepositoryPaths(
        sanitizeTaskOutput(text.trim()),
        ctx.repoRoot,
      );
      const highlighted = theme.renderMarkdown(sanitized);
      const divider = `${colors.darkGray}${'─'.repeat(64)}${colors.reset}`;
      return `  ${colors.brand}✦ ${colors.bold}${header}${colors.reset}\n  ${divider}\n${highlighted}\n  ${divider}\n`;
    })
    .join('\n\n');

  const outputPrefix = outputs
    ? result.status === 'completed'
      ? `${outputs}\n`
      : `  ${colors.yellow}▲ Agent output below is evidence from a failed run. TaskForge did not verify or deliver it.${colors.reset}\n\n${outputs}\n`
    : '';

  const isSuccess = result.status === 'completed';
  const isCancelled = result.status === 'cancelled';
  // READ_ONLY_ANALYSIS runs get a distinct result screen: no delivery
  // block is ever offered (mutation is disabled for the entire run, see
  // RunOrchestrator's delivery gate), and success is framed as goal
  // success ("did we produce a substantive answer with zero repository
  // mutation?"), not "did we produce a mergeable change?".
  const isReadOnly = result.executionIntent?.intent === 'READ_ONLY_ANALYSIS';
  const hasSubstantiveOutput = Object.values(result.taskOutputs ?? {}).some(
    (text) => text && text.trim().length > 0,
  );

  const title = isReadOnly
    ? isSuccess
      ? hasSubstantiveOutput
        ? 'Analysis complete'
        : 'Analysis completed without a substantive answer'
      : isCancelled
        ? 'Analysis cancelled by user'
        : 'Analysis encountered issues'
    : isSuccess
      ? 'Plan executed successfully!'
      : isCancelled
        ? 'Plan execution cancelled by user'
        : 'Plan execution encountered issues';
  const titleIcon =
    isSuccess && (!isReadOnly || hasSubstantiveOutput)
      ? `${colors.green}✔${colors.reset}`
      : isCancelled
        ? `${colors.yellow}⊘${colors.reset}`
        : `${colors.red}✖${colors.reset}`;

  const divider = `${colors.darkGray}${'─'.repeat(64)}${colors.reset}`;

  const usageAccuracy = ctx.telemetry.getUsageAccuracy(result.runId);
  const efficiency = ctx.telemetry.getOrchestrationEfficiency(result.runId);
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

  const dimensionBadge = (status: 'healthy' | 'attention' | 'uncertain'): string =>
    status === 'healthy'
      ? `${colors.green}HEALTHY${colors.reset}`
      : status === 'attention'
        ? `${colors.yellow}NEEDS ATTENTION${colors.reset}`
        : `${colors.yellow}UNCERTAIN${colors.reset}`;

  const overallBadge =
    efficiency.overallHealth === 'excellent'
      ? `${colors.green}EXCELLENT${colors.reset}`
      : efficiency.overallHealth === 'inefficient'
        ? `${colors.red}INEFFICIENT${colors.reset}`
        : efficiency.overallHealth === 'needs_attention'
          ? `${colors.yellow}NEEDS ATTENTION${colors.reset}`
          : `${colors.yellow}INCONCLUSIVE${colors.reset}`;

  const staffingLabel =
    efficiency.outcome === 'right_sized'
      ? `${colors.green}RIGHT-SIZED${colors.reset}`
      : efficiency.outcome === 'fan_out_justified'
        ? `${colors.green}FAN-OUT JUSTIFIED${colors.reset}`
        : efficiency.outcome === 'inefficient'
          ? `${colors.red}INEFFICIENT${colors.reset}`
          : `${colors.yellow}INCONCLUSIVE${colors.reset}`;

  const exactTokens = (value: number) => Math.round(value).toLocaleString('en-US');
  const usageBlock =
    efficiency.providerReportedTokens > 0
      ? [
          `    ${colors.dim}Provider usage:${colors.reset}      ${usageAccuracy.observedAssignments} assignment(s)`,
          `      ${colors.dim}Input:${colors.reset}            ${exactTokens(efficiency.providerInputTokens)} tokens`,
          efficiency.cachedInputTokens > 0
            ? `      ${colors.dim}Cached input:${colors.reset}     ${exactTokens(efficiency.cachedInputTokens)} tokens`
            : '',
          `      ${colors.dim}Output:${colors.reset}           ${exactTokens(efficiency.providerOutputTokens)} tokens`,
          `      ${colors.dim}Total:${colors.reset}            ${exactTokens(efficiency.providerReportedTokens)} tokens`,
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  const efficiencyBlock = [
    `    ${colors.dim}Overall:${colors.reset}            ${overallBadge}`,
    `    ${colors.dim}Staffing:${colors.reset}           ${staffingLabel}`,
    `    ${colors.dim}Quality:${colors.reset}            ${dimensionBadge(efficiency.qualityHealth)}`,
    `    ${colors.dim}Recovery:${colors.reset}           ${dimensionBadge(efficiency.recoveryHealth)}`,
    `    ${colors.dim}Assignments:${colors.reset}        ${efficiency.usefulAssignments} useful / ${efficiency.wastedAssignments} wasted across ${efficiency.uniqueAgents} agent(s)`,
    `    ${colors.dim}Parallel overlap:${colors.reset}   ${(efficiency.observedParallelOverlapMs / 1000).toFixed(1)}s (${efficiency.parallelismFactor.toFixed(2)}×)`,
    efficiency.providerReportedTokens > 0
      ? `    ${colors.dim}Wasted tokens:${colors.reset}      ${formatApproxTokens(efficiency.wastedProviderTokens)} / ${formatApproxTokens(efficiency.providerReportedTokens)}`
      : '',
    `    ${colors.dim}First-pass quality:${colors.reset} ${(efficiency.firstPassRate * 100).toFixed(0)}% · rework ${efficiency.reworkCount} · gate rejects ${efficiency.completionGateRejections}`,
    `    ${colors.dim}Why:${colors.reset}                ${efficiency.reasons[0] ?? 'No efficiency rationale available.'}`,
  ]
    .filter(Boolean)
    .join('\n');
  const delivery = isSuccess && !isReadOnly ? ctx.deliveryService.getDelivery(result.runId) : undefined;
  let deliveryBlock = '';
  let repositoryBlock = '';

  if (isReadOnly) {
    if (isSuccess) {
      repositoryBlock = [
        `    ${colors.dim}Repository:${colors.reset}`,
        `      ${colors.green}✓${colors.reset} Read-only policy respected`,
        `      ${colors.green}✓${colors.reset} Files changed: 0`,
      ].join('\n');
    }
    // deliveryBlock intentionally stays empty: a READ_ONLY_ANALYSIS run is
    // never offered /apply, /diff or /pr, regardless of scheduler status.
  } else if (delivery?.status === 'ready_to_apply') {
    let changedBlock = '';
    try {
      const diffStat = (await ctx.deliveryService.diff(result.runId)).trim();
      if (diffStat) {
        changedBlock = `\n${diffStat
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n')}`;
      }
    } catch {
      // best-effort; delivery block still renders without the diff stat
    }
    deliveryBlock = [
      `    ${colors.dim}Branch:${colors.reset}             ${colors.cyan}${delivery.branch}${colors.reset}`,
      `    ${colors.dim}Changed:${colors.reset}${changedBlock}`,
      `    ${colors.dim}Delivery:${colors.reset}           ${colors.yellow}● READY TO APPLY${colors.reset}`,
      '',
      `    ${colors.dim}/apply${colors.reset}    apply to ${delivery.targetBranch}`,
      `    ${colors.dim}/diff${colors.reset}     inspect changes`,
      `    ${colors.dim}/pr${colors.reset}       create pull request`,
    ].join('\n');
  } else if (delivery?.status === 'applied') {
    deliveryBlock = `    ${colors.dim}Delivery:${colors.reset}           ${colors.green}✔ applied to ${delivery.targetBranch}${colors.reset}${delivery.appliedCommit ? ` (${delivery.appliedCommit.slice(0, 7)})` : ''}`;
  } else if (delivery?.status === 'pr_created') {
    deliveryBlock = `    ${colors.dim}Delivery:${colors.reset}           ${colors.cyan}PR opened${colors.reset}${delivery.prUrl ? ` ${delivery.prUrl}` : ''}`;
  }

  return [
    outputPrefix,
    `  ${colors.brand}✦ ${colors.bold}${isReadOnly ? 'Analysis Summary' : 'Run Summary'}${colors.reset}`,
    `  ${divider}`,
    `  ${titleIcon} ${colors.bold}${title}${colors.reset}`,
    '',
    `    ${colors.dim}Status:${colors.reset}             ${statusColor}${colors.bold}${result.status.toUpperCase()}${colors.reset}`,
    `    ${colors.dim}Tasks completed:${colors.reset}    ${colors.bold}${result.tasksCompleted}${colors.reset}, failed: ${result.tasksFailed}`,
    repositoryBlock,
    usageBlock,
    efficiencyBlock,
    deliveryBlock,
    result.error
      ? `    ${colors.dim}Error:${colors.reset}              ${colors.red}${result.error}${colors.reset}`
      : '',
    `    ${colors.dim}Total time:${colors.reset}         ${colors.yellow}${(result.durationMs / 1000).toFixed(1)}s${colors.reset}`,
    `  ${divider}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * One-line, approximate token budget shown before the user approves a plan,
 * so a large plan cannot spend provider quota without warning. The range is
 * deliberately wide: this is an estimate, not a tokenizer count.
 */
export function formatUsageEstimate(estimate: RunUsageEstimate): string {
  const range = `${formatApproxTokens(estimate.minTokens)}–${formatApproxTokens(estimate.maxTokens)}`;
  const level =
    estimate.maxTokens >= 1_000_000 ? colors.red : estimate.maxTokens >= 250_000 ? colors.yellow : colors.dim;
  return `  ${colors.dim}Estimated usage:${colors.reset} ${level}~${formatApproxTokens(estimate.expectedTokens)} tokens${colors.reset} ${colors.dim}(range ${range}, confidence ${estimate.confidence}; fresh tokens only, excludes cached context and most retries, so provider totals run higher)${colors.reset}`;
}
