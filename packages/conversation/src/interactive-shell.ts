import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  TaskForgeConfig,
  loadConfig,
  DeliveryError,
  ConversationState,
  generateRunId,
  PlannerProvenance,
  resolveOpenAIApiKey,
  getGlobalStateDatabasePath,
  AgentStreamBus,
  AgentMessage,
  ActiveAgentState,
  detectExecutionIntent,
} from '@taskforge/shared';
import { GitService, RepositoryAnalyzer, WorktreeManager } from '@taskforge/workspace';
import {
  AgentRegistry,
  AgentDetector,
  AgentActivityTracker,
  AgentQuotaTracker,
} from '@taskforge/agents';
import { OperatorAgent } from '@taskforge/operator';
import {
  HeuristicPlanner,
  SemanticPlanner,
  enforceLightweightReadOnlyPlanInvariant,
} from '@taskforge/planner';
import { NegotiationManager } from '@taskforge/negotiation';
import {
  StaticRoutingProvider,
  OpenAIRoutingProvider,
  AdaptiveRoutingProvider,
  RoutingProvider,
  RouterHealthReport,
  AgentSelector,
  RouterQualityGuard,
} from '@taskforge/router';
import { TaskGraph, Goal } from '@taskforge/core';
import { RunOrchestrator, OrchestrationResult, sanitizeTaskOutput } from '@taskforge/scheduler';
import {
  TaskForgeDatabase,
  DatabaseHealthReport,
  InteractionRepository,
  RunRepository,
  GoalRepository,
  EventRepository,
  TaskRepository,
  AssignmentRepository,
  AuditService,
  AgentAvailabilityRepository,
} from '@taskforge/persistence';
import {
  TelemetryCollector,
  PerformanceEngine,
  ExecutionUsageEstimator,
  UsageCalibrationEngine,
} from '@taskforge/telemetry';
import { InteractionGateway } from '@taskforge/execution';
import { DeliveryService, GitHubWorkflowService } from '@taskforge/integration';
import { SessionRegistry } from '@taskforge/collaboration';
import { TuiDashboard } from './tui-dashboard.js';
import { theme, colors } from './theme.js';
import { TerminalViewport } from './terminal-viewport.js';
import { SlashMenu, SLASH_COMMANDS } from './slash-menu.js';
import { LiveTicker } from './live-ticker.js';
import { StreamViewer } from './stream-viewer.js';
import { CockpitPanels } from './cockpit-panels.js';

function formatApproxTokens(value: number): string {
  if (value < 1000) return value.toLocaleString();
  const thousands = value / 1000;
  return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}

export interface ShellOptions {
  repoRoot?: string;
  config?: TaskForgeConfig;
  input?: Readable;
  output?: Writable;
  database?: TaskForgeDatabase;
  activityTracker?: AgentActivityTracker;
  streamBus?: AgentStreamBus;
  asyncExecution?: boolean;
  interactive?: boolean;
}

export function findWordLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  while (i > 0 && /\s/.test(text[i])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

export function findWordRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let i = pos;
  while (i < text.length && !/\s/.test(text[i])) i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

export class InteractiveShell {
  private repoRoot: string;
  private config: TaskForgeConfig;
  private db: TaskForgeDatabase;
  private availabilityDb: TaskForgeDatabase;
  private telemetry: TelemetryCollector;
  private usageCalibration: UsageCalibrationEngine;
  private operator: OperatorAgent;
  private agentRegistry: AgentRegistry;
  private gitService: GitService;
  private planner: SemanticPlanner | HeuristicPlanner;
  private negotiator: NegotiationManager;
  private router: RoutingProvider;
  private agentSelector: AgentSelector;
  private interactionRepo: InteractionRepository;
  private interactionGateway: InteractionGateway;
  private deliveryService: DeliveryService;
  private githubWorkflowService: GitHubWorkflowService;
  private currentGraph?: TaskGraph;
  private activeGoal?: Goal;
  private lastGoalDescription?: string;
  private isPaused = false;
  private activeRunId?: string;
  private conversationState: ConversationState = 'IDLE';
  private outStream: Writable;
  public viewport: TerminalViewport;
  public slashMenu: SlashMenu;
  public activityTracker: AgentActivityTracker;
  public streamBus: AgentStreamBus;
  private sessionRegistry: SessionRegistry;
  private eventRepo: EventRepository;
  private taskRepo: TaskRepository;
  private assignmentRepo: AssignmentRepository;
  /** The assignment the cockpit is currently focused on, if any (Focus Mode). */
  private focusedAssignmentId?: string;
  private focusUnsubscribe?: () => void;
  private cockpitUnsubscribe?: () => void;
  private surfacedAttentionByAssignment = new Map<string, string>();
  public activeExecutionController?: AbortController;
  private tickerTimer?: NodeJS.Timeout;
  private tickerFrameIndex = 0;

  constructor(private options: ShellOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.outStream = options.output ?? process.stdout;
    this.viewport = new TerminalViewport(this.outStream, {
      repoName: path.basename(this.repoRoot),
      interactive: options.interactive,
    });
    this.slashMenu = new SlashMenu(this.outStream);
    this.activityTracker = options.activityTracker ?? new AgentActivityTracker();
    this.streamBus = options.streamBus ?? new AgentStreamBus();
    this.sessionRegistry = new SessionRegistry();
    this.config = options.config ?? loadConfig();
    this.db = options.database ?? new TaskForgeDatabase(this.config.execution.databasePath);
    this.availabilityDb =
      options.database ?? new TaskForgeDatabase(getGlobalStateDatabasePath());
    const globalAvailability = new AgentAvailabilityRepository(this.availabilityDb);
    if (this.availabilityDb !== this.db) {
      globalAvailability.mergeFrom(new AgentAvailabilityRepository(this.db));
    }
    AgentQuotaTracker.getInstance().configureStore(globalAvailability);
    this.eventRepo = new EventRepository(this.db);
    this.taskRepo = new TaskRepository(this.db);
    this.assignmentRepo = new AssignmentRepository(this.db);
    this.telemetry = new TelemetryCollector(this.db);
    this.usageCalibration = new UsageCalibrationEngine(this.db);
    this.operator = new OperatorAgent();
    this.agentRegistry = new AgentRegistry();
    this.gitService = new GitService(this.repoRoot);
    const openaiApiKey = resolveOpenAIApiKey(this.config);
    this.planner = new SemanticPlanner({
      apiKey: openaiApiKey,
      // Keep Planner and Router on the same configured model by default.
      // PLANNER_MODEL remains an explicit override, but TaskForge should not
      // silently route with one model while planning with a different hidden
      // default -- that causes avoidable API failures and fallback latency.
      model: process.env.PLANNER_MODEL || this.config.router.model || 'gpt-4o',
    });
    this.negotiator = new NegotiationManager();
    const performanceEngine = new PerformanceEngine(this.db);
    if (this.config.router.adaptive) {
      this.router = new AdaptiveRoutingProvider(performanceEngine);
    } else if (this.config.router.provider === 'openai' && openaiApiKey) {
      this.router = new OpenAIRoutingProvider(
        openaiApiKey,
        this.config.router.model,
        15000,
        { performanceEngine },
      );
    } else {
      this.router = new StaticRoutingProvider();
    }
    this.agentSelector = new AgentSelector(this.agentRegistry, {
      selectionHistory: this.assignmentRepo,
    });
    this.interactionRepo = new InteractionRepository(this.db);
    this.interactionGateway = new InteractionGateway({
      config: this.config,
      interactionRepo: this.interactionRepo,
    });
    this.deliveryService = new DeliveryService(
      this.repoRoot,
      this.gitService,
      new RunRepository(this.db),
    );
    this.githubWorkflowService = new GitHubWorkflowService(this.db, this.repoRoot);
    this.setupActivitySubscription();
    this.setupCockpitEventSubscription();
  }

  private setupActivitySubscription(): void {
    this.activityTracker.subscribe((active) => {
      this.surfaceAttentionPanels(active);
      if (active.length > 0) {
        if (!this.tickerTimer) {
          this.tickerTimer = setInterval(() => {
            this.tickerFrameIndex++;
            this.renderActivityTicker();
          }, 120);
        }
        this.renderActivityTicker();
      } else {
        if (this.tickerTimer) {
          clearInterval(this.tickerTimer);
          this.tickerTimer = undefined;
        }
        this.viewport.drawFooter('', []);
      }
    });
  }

  private surfaceAttentionPanels(active: ActiveAgentState[]): void {
    const attentionAssignments = new Set<string>();

    for (const state of active) {
      const attention = state.attentionRequired;
      if (!attention) continue;

      attentionAssignments.add(state.assignmentId);
      const key =
        attention.requestId ??
        [attention.type, attention.operation, attention.resource, attention.prompt].filter(Boolean).join(':');

      if (this.surfacedAttentionByAssignment.get(state.assignmentId) === key) {
        continue;
      }

      this.surfacedAttentionByAssignment.set(state.assignmentId, key);
      const panel = CockpitPanels.actionRequired(state);
      if (panel) {
        this.viewport.writeUpper('\n' + panel + '\n');
      }
    }

    for (const assignmentId of this.surfacedAttentionByAssignment.keys()) {
      if (!attentionAssignments.has(assignmentId)) {
        this.surfacedAttentionByAssignment.delete(assignmentId);
      }
    }
  }

  private setupCockpitEventSubscription(): void {
    this.cockpitUnsubscribe = this.streamBus.subscribeAll((event) => {
      if (event.type !== 'investigator_failover') return;
      this.viewport.writeUpper('\n' + CockpitPanels.failover(event) + '\n');
    });
  }

  public renderActivityTicker(): void {
    const active = this.activityTracker.getActive();
    if (active.length === 0) {
      this.viewport.drawFooter('', []);
      return;
    }
    const lines = LiveTicker.render({
      activeAgents: active,
      registeredAgents: this.agentRegistry.list(),
      frameIndex: this.tickerFrameIndex,
      terminalCols: this.viewport.cols,
    });
    this.viewport.drawFooter('', lines);
  }

  /**
   * Focus Mode: subscribes live to one assignment's AgentStreamEvents so new
   * tool calls/messages append to the scrollback as they happen -- not just
   * at the moment `/stream` was typed -- mirroring how the ticker footer
   * already updates live via activityTracker.subscribe(). The persistent
   * prompt is untouched; typing plain text while focused sends it to this
   * assignment's agent instead of starting a new task (see handleInput).
   */
  private enterFocusMode(assignmentId: string, allActive: ActiveAgentState[]): string {
    this.focusUnsubscribe?.();
    this.focusedAssignmentId = assignmentId;
    this.focusUnsubscribe = this.streamBus.subscribeAssignment(assignmentId, (event) => {
      const line = StreamViewer.formatStreamEvent(event);
      if (line) this.viewport.writeUpper(`${line}\n`);
    });

    const activeAgent = allActive.find((a) => a.assignmentId === assignmentId) ?? allActive[0];
    return StreamViewer.renderAssignmentFocusView({
      activeAgent,
      allActive,
      streamEvents: this.streamBus.history(assignmentId),
    });
  }

  private exitFocusMode(): string {
    this.focusUnsubscribe?.();
    this.focusUnsubscribe = undefined;
    this.focusedAssignmentId = undefined;
    return `${colors.dim}Back to overview. REPL is ready.${colors.reset}`;
  }

  private switchFocus(indexOneBased: number): string {
    const { active: pool, target } = this.resolveFocusPoolTarget(indexOneBased);
    if (pool.length === 0) {
      return 'No active agent tasks to focus on.';
    }
    if (!target) {
      return `No agent at position ${indexOneBased}. There ${pool.length === 1 ? 'is' : 'are'} ${pool.length} active agent(s) to switch between.`;
    }
    return this.enterFocusMode(target.assignmentId, pool);
  }

  private async sendMessageToFocusedAgent(text: string): Promise<string> {
    if (!this.focusedAssignmentId) {
      return 'No agent is focused. Use /stream <task> or /focus <n> first.';
    }
    const registered = this.sessionRegistry.getByAssignment(this.focusedAssignmentId);
    if (!registered || !registered.adapter.send) {
      return `${colors.dim}(${this.focusedAssignmentId} has no active session to message right now)${colors.reset}`;
    }

    const message: AgentMessage = {
      id: `msg-${randomUUID()}`,
      runId: registered.runId,
      taskId: registered.taskId,
      fromAssignmentId: 'operator',
      toAssignmentId: registered.assignmentId,
      type: 'context_request',
      body: text,
      createdAt: new Date(),
    };

    try {
      await registered.adapter.send(registered.sessionId, message);
    } catch (err) {
      return `Failed to deliver message to ${registered.adapter.name}: ${(err as Error).message}`;
    }

    this.eventRepo.append({
      id: `evt-${randomUUID()}`,
      runId: registered.runId,
      taskId: registered.taskId,
      type: 'OPERATOR_MESSAGE_SENT',
      payload: { assignmentId: registered.assignmentId, agentId: registered.adapter.id, message: text },
      timestamp: new Date(),
    });

    return `${colors.dim}→ sent to ${registered.adapter.name}${colors.reset}`;
  }

  /** Resolves an index within the current focus pool (or all active assignments if unfocused). */
  private resolveFocusPoolTarget(indexOneBased: number): { active: ActiveAgentState[]; target?: ActiveAgentState } {
    const active = this.activityTracker.getActive();
    const current = this.focusedAssignmentId
      ? active.find((a) => a.assignmentId === this.focusedAssignmentId)
      : undefined;
    const pool = current ? active.filter((a) => a.taskId === current.taskId) : active;
    return { active: pool, target: pool[indexOneBased - 1] };
  }

  private async cancelAssignmentByIndex(indexOneBased: number): Promise<string> {
    const { active: pool, target } = this.resolveFocusPoolTarget(indexOneBased);
    if (pool.length === 0) {
      return 'No active agent tasks to cancel.';
    }
    if (!target) {
      return `No agent at position ${indexOneBased}. There ${pool.length === 1 ? 'is' : 'are'} ${pool.length} active agent(s).`;
    }

    const registered = this.sessionRegistry.getByAssignment(target.assignmentId);
    if (!registered || !registered.adapter.cancel) {
      return `${colors.dim}(${target.agentName} has no cancellable session right now)${colors.reset}`;
    }

    try {
      await registered.adapter.cancel(registered.sessionId);
    } catch (err) {
      return `Failed to cancel ${registered.adapter.name}: ${(err as Error).message}`;
    }

    this.activityTracker.updateStatus(target.assignmentId, 'Cancelled by operator');
    return `${colors.yellow}⊘ Cancelled ${target.agentName}${colors.reset} ${colors.dim}(${target.role})${colors.reset}`;
  }

  private showRawLog(indexOneBased?: number): string {
    const { active: pool, target: explicitTarget } = this.resolveFocusPoolTarget(indexOneBased ?? 1);
    const target =
      indexOneBased !== undefined
        ? explicitTarget
        : (pool.find((a) => a.assignmentId === this.focusedAssignmentId) ?? pool[0]);

    if (!target) {
      return 'No active agent to inspect. Use /stream <task> first, or /raw <n>.';
    }
    if (!target.logPath || !fs.existsSync(target.logPath)) {
      return `${colors.dim}No raw log recorded yet for ${target.agentName} (${target.assignmentId}).${colors.reset}`;
    }

    const MAX_RAW_LINES = 500;
    let raw: string;
    try {
      raw = fs.readFileSync(target.logPath, 'utf8');
    } catch (err) {
      return `Could not read log for ${target.agentName}: ${(err as Error).message}`;
    }
    const lines = raw.split('\n');
    const truncated = lines.length > MAX_RAW_LINES;
    const shown = truncated ? lines.slice(-MAX_RAW_LINES) : lines;

    const header = `  ${colors.brand}✦ Raw log — ${target.agentName} (${target.assignmentId})${colors.reset}`;
    const notice = truncated
      ? `  ${colors.dim}(showing last ${MAX_RAW_LINES} of ${lines.length} lines)${colors.reset}\n`
      : '';
    return [header, notice, shown.join('\n')].filter(Boolean).join('\n');
  }

  /**
   * Live /tasks view (Part 21): every active assignment grouped by task,
   * showing agent, role, running duration and current activity -- the same
   * identity model the activity tracker and cockpit tabs use, so this stays
   * consistent with /stream and the ticker rather than a third data source.
   */
  private formatActiveTasksView(active: ActiveAgentState[], filterTaskId?: string): string {
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
  private formatRunInspection(runIdArg?: string): string {
    const runId = runIdArg ?? this.activeRunId ?? new RunRepository(this.db).listAll()[0]?.id;
    if (!runId) {
      return 'No runs recorded yet.';
    }

    const goalRepo = new GoalRepository(this.db);
    const audit = new AuditService(new RunRepository(this.db), goalRepo, this.taskRepo, this.eventRepo).reconstructRun(
      runId,
    );
    if (!audit) {
      return `No run found with id ${runId}. Use /runs to see recorded runs.`;
    }

    const { run, goal, tasks, events } = audit;
    const assignments = this.assignmentRepo.listByRun(runId);
    const delivery = this.deliveryService.getDelivery(runId);

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
          const agentName = this.agentRegistry.get(a.agentId)?.name ?? a.agentId;
          const badge = theme.statusBadge(a.status);
          const reason = a.completionReason ? ` ${colors.dim}(${a.completionReason})${colors.reset}` : '';
          lines.push(`    ${colors.dim}${a.id}${colors.reset}  ${agentName}  ${a.role}  ${badge}${reason}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  private resolveDeliveryRunId(explicit?: string): string | undefined {
    if (explicit) return explicit;
    return this.deliveryService.findLatestReady()?.runId;
  }

  /**
   * Summary-first diff view (Part 20): total files/insertions/deletions up
   * top, then a per-file M/A/D list. Never dumps a full unified diff
   * automatically -- that stays an explicit, separate escape hatch.
   */
  private async formatRunDiff(runId: string): Promise<string> {
    const delivery = this.deliveryService.getDelivery(runId);
    if (!delivery) {
      return `Run ${runId} has no delivery information.`;
    }

    const stat = await this.deliveryService.diff(runId);
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
      const nameStatus = await this.gitService.exec(
        ['diff', '--name-status', `${delivery.targetBranch}...${delivery.branch}`],
        this.repoRoot,
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

  private async formatRunSummary(result: OrchestrationResult): Promise<string> {
    const statusColor =
      result.status === 'completed'
        ? colors.green
        : result.status === 'cancelled'
          ? colors.yellow
          : colors.red;

    const outputs = Object.entries(result.taskOutputs ?? {})
      .filter(([, text]) => text && text.trim().length > 0)
      .map(([taskId, text]) => {
        const header = `Explanation & Analysis [${taskId}]`;
        const sanitized = sanitizeTaskOutput(text.trim());
        const highlighted = theme.renderMarkdown(sanitized);
        const divider = `${colors.darkGray}${'─'.repeat(64)}${colors.reset}`;
        return `  ${colors.brand}✦ ${colors.bold}${header}${colors.reset}\n  ${divider}\n${highlighted}\n  ${divider}\n`;
      })
      .join('\n\n');

    const outputPrefix = outputs ? `${outputs}\n` : '';

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

    const usageAccuracy = this.telemetry.getUsageAccuracy(result.runId);
    const varianceRatio = usageAccuracy.varianceRatio;
    const highVariance = varianceRatio !== undefined && varianceRatio > 3;
    const usageBlock =
      usageAccuracy.observedAssignments > 0
        ? usageAccuracy.plannedEstimatedTokens > 0
          ? highVariance
            ? `    ${colors.dim}Provider-reported usage:${colors.reset} ${colors.bold}${formatApproxTokens(usageAccuracy.observedTokens)} tokens${colors.reset} across ${usageAccuracy.observedAssignments} assignment(s)\n    ${colors.dim}Planning baseline:${colors.reset}       ${formatApproxTokens(usageAccuracy.plannedEstimatedTokens)} ${colors.yellow}▲ ${varianceRatio!.toFixed(1)}× variance${colors.reset}\n    ${colors.dim}Usage note:${colors.reset}              Baseline excludes retries and provider/runtime context; use /cost for input/cache/output detail.`
            : `    ${colors.dim}Provider-reported usage:${colors.reset} ${colors.bold}${formatApproxTokens(usageAccuracy.observedTokens)} tokens${colors.reset} across ${usageAccuracy.observedAssignments} assignment(s)\n    ${colors.dim}Planning baseline:${colors.reset}       ${formatApproxTokens(usageAccuracy.plannedEstimatedTokens)} (${((varianceRatio ?? 1) * 100).toFixed(0)}% provider / baseline)`
          : `    ${colors.dim}Provider-reported usage:${colors.reset} ${colors.bold}${formatApproxTokens(usageAccuracy.observedTokens)} tokens${colors.reset} across ${usageAccuracy.observedAssignments} assignment(s)`
        : '';

    const efficiency = this.telemetry.getOrchestrationEfficiency(result.runId);
    const efficiencyLabel =
      efficiency.outcome === 'right_sized'
        ? `${colors.green}RIGHT-SIZED${colors.reset}`
        : efficiency.outcome === 'fan_out_justified'
          ? `${colors.green}FAN-OUT JUSTIFIED${colors.reset}`
          : efficiency.outcome === 'inefficient'
            ? `${colors.red}INEFFICIENT${colors.reset}`
            : `${colors.yellow}INCONCLUSIVE${colors.reset}`;
    const efficiencyBlock = [
      `    ${colors.dim}Orchestration:${colors.reset}      ${efficiencyLabel}`,
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

    const delivery = isSuccess && !isReadOnly ? this.deliveryService.getDelivery(result.runId) : undefined;
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
        const diffStat = (await this.deliveryService.diff(result.runId)).trim();
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

  async renderBanner(): Promise<string> {
    const gitStatus = await this.gitService.getStatus().catch(() => ({
      currentBranch: 'unknown',
      headCommit: 'unknown',
      isClean: true,
    }));

    const analyzer = new RepositoryAnalyzer(this.repoRoot, this.gitService);
    const profile = await analyzer.analyze().catch(() => ({
      hasECC: false,
      summary: 'Repository',
      languages: [],
      frameworks: [],
      testCommands: [],
      lintCommands: [],
      typecheckCommands: [],
      buildCommands: [],
    }));

    const reports = await AgentDetector.detect(this.agentRegistry.list());
    const cleanLabel = gitStatus.isClean
      ? `${colors.green}clean${colors.reset}`
      : `${colors.yellow}modified${colors.reset}`;
    const apiKey = resolveOpenAIApiKey(this.config);
    let routerStatus: string;
    if (this.config.router.provider === 'openai') {
      if (!apiKey) {
        routerStatus = `${colors.gray}○ missing key${colors.reset} ${colors.dim}(static fallback)${colors.reset}`;
      } else {
        const shouldValidate =
          !process.env.VITEST || process.env.TASKFORGE_TEST_VALIDATE_KEY === 'true';
        const report =
          shouldValidate && typeof this.router.healthCheck === 'function'
            ? await this.router.healthCheck({ validateKey: true })
            : { status: 'healthy' as const };
        if (report.status === 'healthy') {
          routerStatus = `${colors.green}● ready${colors.reset} ${colors.dim}(OpenAI ${this.config.router.model})${colors.reset}`;
        } else if (report.details?.includes('invalid') || report.details?.includes('401')) {
          routerStatus = `${colors.red}○ invalid key${colors.reset} ${colors.dim}(static fallback)${colors.reset}`;
        } else {
          routerStatus = `${colors.yellow}○ degraded${colors.reset} ${colors.dim}(static fallback)${colors.reset}`;
        }
      }
    } else {
      routerStatus = `${colors.gray}● static fallback${colors.reset}`;
    }

    const lines = [
      '',
      ` ${colors.brand}╭─────────────────────────────────────────────────────────────────╮${colors.reset}`,
      ` ${colors.brand}│${colors.reset}  ${colors.brand}${colors.bold}✦ TaskForge Control Plane${colors.reset}                              ${colors.dim}v0.1.0${colors.reset}  ${colors.brand}│${colors.reset}`,
      ` ${colors.brand}│${colors.reset}  ${colors.dim}Autonomous multi-agent coordination & git-worktree engine${colors.reset}      ${colors.brand}│${colors.reset}`,
      ` ${colors.brand}╰─────────────────────────────────────────────────────────────────╯${colors.reset}`,
      '',
      `  ${colors.dim}Repository${colors.reset}  ${colors.bold}${this.repoRoot}${colors.reset}`,
      `  ${colors.dim}Git Status${colors.reset}  ${colors.yellow}${gitStatus.currentBranch}${colors.reset} ${colors.dim}(${gitStatus.headCommit.slice(0, 7)})${colors.reset} • ${cleanLabel}`,
      '',
      `  ${colors.bold}Agents${colors.reset}`,
      ...reports.map(
        (r) =>
          `    ${theme.agentPill(
            r.id,
            r.name,
            r.ready,
            r.quotaStatus,
            r.quotaReason,
            r.resetAt,
          )}`,
      ),
      '',
      `  ${colors.bold}Router${colors.reset}      OpenAI       ${routerStatus}`,
      `  ${colors.bold}ECC${colors.reset}         ${profile.hasECC ? `${colors.green}● detected${colors.reset}` : `${colors.gray}○ not detected${colors.reset}`}`,
      ` ${colors.brand}─────────────────────────────────────────────────────────────────${colors.reset}`,
      '',
    ];

    return lines.join('\n');
  }

  async handleInput(input: string, abortSignal?: AbortSignal): Promise<string> {
    const text = input.trim();
    if (!text) return '';

    if (text === '/exit' || text === '/quit' || text === 'exit' || text === 'quit') {
      return 'Session closed.';
    }

    if (text === '/clean') {
      const worktreeManager = new WorktreeManager(
        this.repoRoot,
        this.config.execution.worktreesDir,
      );
      const deletedBranches = await worktreeManager.cleanOrphanedWorktreesAndBranches();
      return `Cleaned up orphaned worktrees and ${deletedBranches} temporary branch(es).`;
    }

    // Focus Mode navigation. Recognized as literal commands (not routed
    // through the operator's NLU intent parser) precisely so they work the
    // same way whether or not the cockpit is currently focused.
    if (text === '/back' || text === '/overview' || text === 'q') {
      if (this.focusedAssignmentId) {
        return this.exitFocusMode();
      }
      // 'q' with nothing focused is not a recognized overview command --
      // fall through to normal intent handling below.
    }

    const focusMatch = text.match(/^\/(?:focus|agent)\s+(\d+)$/i);
    if (focusMatch) {
      return this.switchFocus(parseInt(focusMatch[1], 10));
    }

    // Per-assignment cancel: /cancel <n> targets one agent in the current
    // focus pool. Bare /cancel (no index) keeps its existing whole-run
    // meaning via cancel_and_reassign below -- this must never change.
    const cancelOneMatch = text.match(/^\/cancel\s+(\d+)$/i);
    if (cancelOneMatch) {
      return this.cancelAssignmentByIndex(parseInt(cancelOneMatch[1], 10));
    }

    // /raw <n> dumps the full persisted log for one assignment, unformatted
    // -- the escape hatch when the normalized event view isn't enough.
    const rawMatch = text.match(/^\/raw(?:\s+(\d+))?$/i);
    if (rawMatch) {
      return this.showRawLog(rawMatch[1] ? parseInt(rawMatch[1], 10) : undefined);
    }

    // /inspect [run] reviews a completed (or in-progress) run's full
    // Run -> Task -> Assignment hierarchy, including intent normalization,
    // routing and mutation-guard events -- the "what actually happened"
    // view /stream doesn't cover once agents have finished.
    const inspectMatch = text.match(/^\/inspect(?:\s+(\S+))?$/i);
    if (inspectMatch) {
      return this.formatRunInspection(inspectMatch[1]);
    }

    // Focus Mode messaging: plain text (not a /command) while an assignment
    // is focused talks to that agent instead of being parsed as a new goal.
    if (this.focusedAssignmentId && !text.startsWith('/')) {
      return this.sendMessageToFocusedAgent(text);
    }

    const intent = this.operator.parseIntent(text, {
      conversationState: this.conversationState,
      hasActivePlan: Boolean(this.currentGraph),
      hasPendingInteractions: this.interactionGateway.getPendingRequests().length > 0,
      hasDeliverable: Boolean(this.activeRunId && this.deliveryService.getDelivery(this.activeRunId)),
    });

    switch (intent.type) {
      case 'inspect_agents': {
        const reports = await AgentDetector.detect(this.agentRegistry.list());
        return this.operator.formatResponse(intent, { agents: reports });
      }

      case 'inspect_health': {
        // 1. Router health probe
        let routerHealth: RouterHealthReport;
        const shouldValidate =
          !process.env.VITEST || process.env.TASKFORGE_TEST_VALIDATE_KEY === 'true';
        if (typeof this.router.healthCheck === 'function') {
          routerHealth = await this.router.healthCheck({ validateKey: shouldValidate });
        } else {
          routerHealth = {
            status: 'healthy',
            provider: this.router.id,
            adaptive: this.config.router.adaptive ?? false,
            details: `Active provider: ${this.router.id}`,
          };
        }

        // 2. Agents health probe
        const agentReports = await AgentDetector.detect(this.agentRegistry.list());
        const totalAgents = agentReports.length;
        const readyAgents = agentReports.filter((a) => a.ready).length;
        const agentStatus: 'healthy' | 'degraded' | 'unhealthy' =
          readyAgents === totalAgents
            ? 'healthy'
            : readyAgents > 0
              ? 'degraded'
              : 'unhealthy';

        // 3. Database health probe
        const dbHealth: DatabaseHealthReport = this.db.healthCheck();

        // 4. Overall system status
        const isAllHealthy =
          routerHealth.status === 'healthy' &&
          agentStatus === 'healthy' &&
          dbHealth.status === 'healthy';
        const hasUnhealthy =
          routerHealth.status === 'unhealthy' ||
          agentStatus === 'unhealthy' ||
          dbHealth.status === 'unhealthy';
        const overallStatus = isAllHealthy
          ? `${colors.green}${colors.bold}✔ ALL SYSTEMS OPERATIONAL${colors.reset}`
          : hasUnhealthy
            ? `${colors.red}${colors.bold}✖ SYSTEM UNHEALTHY${colors.reset}`
            : `${colors.yellow}${colors.bold}⚠ SYSTEM DEGRADED${colors.reset}`;

        const divider = `${colors.darkGray}${'─'.repeat(64)}${colors.reset}`;
        const header = `${colors.brand}✦ ${colors.bold}TaskForge System Health${colors.reset}\n  ${divider}`;

        // Format router section
        const routerBadge =
          routerHealth.status === 'healthy'
            ? `${colors.green}${colors.bold}✔ HEALTHY${colors.reset}`
            : routerHealth.status === 'degraded'
              ? `${colors.yellow}${colors.bold}⚠ DEGRADED${colors.reset}`
              : `${colors.red}${colors.bold}✖ UNHEALTHY${colors.reset}`;
        const routerDetails = [
          `  ${colors.bold}Routing Provider:${colors.reset}   ${colors.cyan}${routerHealth.provider}${colors.reset} ${routerBadge}`,
          routerHealth.model ? `    ${colors.dim}Model:${colors.reset}          ${routerHealth.model}` : undefined,
          routerHealth.details ? `    ${colors.dim}Details:${colors.reset}        ${colors.dim}${routerHealth.details}${colors.reset}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');

        // Format agent fleet section
        const agentBadge =
          agentStatus === 'healthy'
            ? `${colors.green}${colors.bold}✔ HEALTHY${colors.reset}`
            : agentStatus === 'degraded'
              ? `${colors.yellow}${colors.bold}⚠ DEGRADED${colors.reset}`
              : `${colors.red}${colors.bold}✖ UNHEALTHY${colors.reset}`;
        const agentSummary = `  ${colors.bold}Agent Fleet:${colors.reset}        ${readyAgents}/${totalAgents} ready ${agentBadge}`;
        const agentLines = agentReports
          .map(
            (rep) =>
              `    ${theme.agentPill(
                rep.id,
                rep.name,
                rep.ready,
                rep.quotaStatus,
                rep.quotaReason,
                rep.resetAt,
              )}`,
          )
          .join('\n');

        // Format database section
        const dbBadge =
          dbHealth.status === 'healthy'
            ? `${colors.green}${colors.bold}✔ HEALTHY${colors.reset}`
            : `${colors.red}${colors.bold}✖ UNHEALTHY${colors.reset}`;
        const dbDetails = [
          `  ${colors.bold}Local SQLite DB:${colors.reset}    ${dbBadge} ${colors.dim}(${dbHealth.latencyMs}ms)${colors.reset}`,
          `    ${colors.dim}Path:${colors.reset}           ${dbHealth.path}`,
          `    ${colors.dim}Integrity:${colors.reset}      ${dbHealth.integrityOk ? `${colors.green}ok${colors.reset}` : `${colors.red}failed${colors.reset}`}${dbHealth.journalMode ? ` • WAL mode (${dbHealth.journalMode})` : ''}`,
          `    ${colors.dim}Stats:${colors.reset}          ${dbHealth.tables} tables • ${dbHealth.totalRuns} runs • ${dbHealth.totalTasks} tasks`,
          dbHealth.error ? `    ${colors.red}Error:${colors.reset}         ${dbHealth.error}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');

        return [
          header,
          routerDetails,
          '',
          agentSummary,
          agentLines,
          '',
          dbDetails,
          `  ${divider}`,
          `  ${colors.bold}Status:${colors.reset}             ${overallStatus}`,
          `  ${divider}`,
        ].join('\n');
      }

      case 'inspect_tasks': {
        const active = this.activityTracker.getActive();
        if (active.length > 0) {
          return this.formatActiveTasksView(active, intent.taskId);
        }
        const tasks = this.currentGraph
          ? this.currentGraph.getAllTasks().map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
            }))
          : [];
        return this.operator.formatResponse(intent, { tasks });
      }

      case 'inspect_plan': {
        if (!this.currentGraph) {
          return 'No active plan at the moment.';
        }
        const tasks = this.currentGraph.getAllTasks();
        const header = 'Current task plan:';
        const depPrefix = 'Depends on: ';
        return [
          `${colors.brand}✦ ${header}${colors.reset}`,
          ...tasks.map((t) => {
            const icon = theme.taskTypeIcon(t.type);
            const badge = theme.statusBadge(t.status);
            const depText =
              t.dependencies.length > 0
                ? ` ${colors.dim}(${depPrefix}${t.dependencies.join(', ')})${colors.reset}`
                : '';
            return `  ${icon} ${colors.cyan}${t.id}${colors.reset}: ${colors.bold}${t.title}${colors.reset} [${t.status.toUpperCase()}] ${badge}${depText}`;
          }),
        ].join('\n');
      }

      case 'inspect_runs': {
        const runRepo = new RunRepository(this.db);
        const goalRepo = new GoalRepository(this.db);
        const runs = runRepo.listAll();
        if (runs.length === 0) {
          return 'No execution runs recorded yet.';
        }
        const divider = `${colors.darkGray}${'─'.repeat(64)}${colors.reset}`;
        const header = `${colors.brand}✦ ${colors.bold}TaskForge Runs History${colors.reset}\n  ${divider}`;
        const runLines = runs.slice(0, 10).map((r) => {
          const goal = r.goalId ? goalRepo.get(r.goalId) : undefined;
          const statusBadge = theme.statusBadge(r.status);
          const goalDesc = goal ? `\n    ${colors.dim}Goal:${colors.reset}   ${goal.description}` : '';
          const delivery = this.deliveryService.getDelivery(r.id);
          let deliveryBlock = '';
          if (delivery) {
            const badge =
              delivery.status === 'applied'
                ? `${colors.green}✔ APPLIED${colors.reset} to ${delivery.targetBranch}${delivery.appliedCommit ? ` (${delivery.appliedCommit.slice(0, 7)})` : ''}`
                : delivery.status === 'pr_created'
                  ? `${colors.cyan}PR opened${colors.reset}${delivery.prUrl ? ` ${delivery.prUrl}` : ''}`
                  : delivery.status === 'discarded'
                    ? `${colors.dim}discarded${colors.reset}`
                    : `${colors.yellow}● READY TO APPLY${colors.reset}`;
            const hint =
              delivery.status === 'ready_to_apply'
                ? `\n    ${colors.dim}/apply ${r.id}    /diff ${r.id}    /pr ${r.id}${colors.reset}`
                : '';
            deliveryBlock = `\n    ${colors.dim}Branch:${colors.reset}   ${colors.cyan}${delivery.branch}${colors.reset}\n    ${colors.dim}Delivery:${colors.reset} ${badge}${hint}`;
          }
          return `  ● ${colors.bold}${r.id}${colors.reset} [${r.status.toUpperCase()}] ${statusBadge} ${colors.dim}(${r.createdAt.slice(0, 19).replace('T', ' ')})${colors.reset}${goalDesc}${deliveryBlock}`;
        });
        return [header, ...runLines, `  ${divider}`].join('\n');
      }

      case 'apply_run': {
        const targetRunId = this.resolveDeliveryRunId(intent.runId);
        if (!targetRunId) {
          return 'No run is ready to apply. Use /runs to see the delivery status of past runs.';
        }
        const delivery = this.deliveryService.getDelivery(targetRunId);
        if (!delivery) {
          return `Run ${targetRunId} has no delivery information.`;
        }
        const before = await this.gitService.getStatus().catch(() => undefined);
        // Capture the file list BEFORE applying: once merged, targetBranch
        // already contains everything from the integration branch, so a
        // diff taken afterward would show nothing useful.
        const preApplyDiff = await this.deliveryService.diff(targetRunId).catch(() => '');
        try {
          const result = await this.deliveryService.apply(targetRunId);
          if (result.alreadyApplied) {
            return `${colors.green}✔${colors.reset} ${targetRunId} was already applied to ${delivery.targetBranch}${delivery.appliedCommit ? ` (${delivery.appliedCommit.slice(0, 7)})` : ''}.`;
          }
          const beforeShort = before?.headCommit ? before.headCommit.slice(0, 7) : '?';
          const afterShort = result.commit.slice(0, 7);

          const fileLines = preApplyDiff
            .split('\n')
            .filter((l) => l.includes('|'))
            .map((l) => `  ${colors.dim}M${colors.reset} ${l.split('|')[0].trim()}`);

          let commitSubject = '';
          try {
            commitSubject = (
              await this.gitService.exec(['log', '-1', '--pretty=%s', result.commit], this.repoRoot)
            ).trim();
          } catch {
            // best-effort
          }

          const sections: string[][] = [
            [`${colors.brand}✦ ${colors.bold}Applied successfully${colors.reset}`],
            [`  ${delivery.targetBranch}`, `  ${beforeShort} → ${afterShort}`],
          ];
          if (fileLines.length > 0) {
            sections.push([`  ${colors.dim}Files${colors.reset}`, ...fileLines]);
          }
          sections.push([`  ${colors.dim}Commit${colors.reset}`, `  ${afterShort}  ${commitSubject}`]);

          return sections.map((s) => s.join('\n')).join('\n\n');
        } catch (err) {
          const conflictingFiles =
            err instanceof DeliveryError
              ? (err.context?.conflictingFiles as string[] | undefined)
              : undefined;
          if (conflictingFiles?.length) {
            return [
              `${colors.brand}✦ ${colors.bold}Integration conflict detected${colors.reset}`,
              '',
              `${delivery.targetBranch} has changes that conflict with ${delivery.branch}.`,
              '',
              'Conflicting files:',
              ...conflictingFiles.map((f) => `  ${f}`),
              '',
              `I won't touch ${delivery.targetBranch}. Inspect with /diff ${targetRunId}, resolve manually, then retry /apply ${targetRunId}.`,
            ].join('\n');
          }
          return `${colors.red}✖ Could not apply ${targetRunId}:${colors.reset} ${(err as Error).message}`;
        }
      }

      case 'diff_run': {
        const targetRunId = this.resolveDeliveryRunId(intent.runId);
        if (!targetRunId) {
          return 'No run is ready to inspect. Use /runs to see past runs.';
        }
        try {
          return await this.formatRunDiff(targetRunId);
        } catch (err) {
          return `${colors.red}✖ ${(err as Error).message}${colors.reset}`;
        }
      }

      case 'create_pr': {
        const targetRunId = this.resolveDeliveryRunId(intent.runId);
        if (!targetRunId) {
          return 'No run is ready for a pull request. Use /runs to see past runs.';
        }
        const delivery = this.deliveryService.getDelivery(targetRunId);
        const result = await this.githubWorkflowService.createPullRequest({
          runId: targetRunId,
          targetBranch: delivery?.targetBranch,
          repoRoot: this.repoRoot,
        });
        if (result.success && result.prUrl) {
          this.deliveryService.markPrCreated(targetRunId, result.prUrl);
        }
        return result.message;
      }

      case 'discard_run': {
        const targetRunId = this.resolveDeliveryRunId(intent.runId);
        if (!targetRunId) {
          return 'No run is ready to discard. Use /runs to see past runs.';
        }
        this.deliveryService.discard(targetRunId);
        return `Run ${targetRunId} marked as discarded. The integration branch was kept, nothing was merged.`;
      }

      case 'inspect_cost': {
        if (!this.activeRunId) {
          return 'No active or recent runs for cost inquiry.';
        }
        return this.telemetry.formatCostReport(this.activeRunId);
      }

      case 'inspect_stats': {
        if (!this.activeRunId) {
          return 'No active or recent runs for statistics inquiry.';
        }
        return this.telemetry.formatStatsReport(this.activeRunId);
      }

      case 'inspect_dashboard': {
        const gitStatus = await this.gitService.getStatus().catch(() => ({
          currentBranch: 'unknown',
          headCommit: 'unknown',
          isClean: true,
        }));
        const reports = await AgentDetector.detect(this.agentRegistry.list());
        const runStats = this.activeRunId
          ? this.telemetry.getRunSummary(this.activeRunId)
          : undefined;
        const costReport = this.activeRunId
          ? this.telemetry.getCostReport(this.activeRunId)
          : undefined;
        return TuiDashboard.render({
          repoRoot: this.repoRoot,
          branch: gitStatus.currentBranch,
          headCommit: gitStatus.headCommit,
          isClean: gitStatus.isClean,
          graph: this.currentGraph,
          agents: reports,
          runStats,
          costReport,
        });
      }

      case 'pause_execution': {
        this.isPaused = true;
        return this.operator.formatResponse(intent, {});
      }

      case 'resume_execution': {
        this.isPaused = false;
        return this.operator.formatResponse(intent, {});
      }

      case 'add_constraint': {
        return this.operator.formatResponse(intent, {});
      }

      case 'cancel_and_reassign': {
        if (this.activeExecutionController) {
          this.activeExecutionController.abort();
          this.activeExecutionController = undefined;
          return 'Plan execution cancelled by user.';
        }
        return this.operator.formatResponse(intent, {});
      }

      case 'submit_goal': {
        this.activeRunId = generateRunId();
        this.conversationState = 'PLANNING';
        this.lastGoalDescription = intent.goal;
        const goal: Goal = {
          id: `goal-${Date.now()}`,
          description: intent.goal,
          repository: this.repoRoot,
          constraints: [],
          acceptanceCriteria: [],
          createdAt: new Date(),
        };
        this.activeGoal = goal;

        const executionIntent = detectExecutionIntent(intent.goal);
        const proposedGraph = await this.planner.plan(goal);
        const negotiatedGraph = await this.negotiator.negotiateGraph(
          proposedGraph,
          this.activeRunId,
        );
        const invariant = enforceLightweightReadOnlyPlanInvariant(
          negotiatedGraph,
          goal,
          executionIntent,
        );
        this.currentGraph = invariant.graph;

        const tasks = this.currentGraph.getAllTasks();
        const primaryTask = tasks[0];

        const availableAgentIds = await this.agentSelector.listAvailableAgentIds();
        const routingProposal = await this.router.route({
          task: primaryTask,
          availableAgents: availableAgentIds,
        });
        const routing = RouterQualityGuard.evaluate(routingProposal, {
          task: primaryTask,
          availableAgents: availableAgentIds,
        });

        const selected = await this.agentSelector.selectAgents(routing.roles, {
          selectionKey: `${this.repoRoot}:${primaryTask.id}`,
        });

        const strategyUpper = routing.strategy.toUpperCase();
        const strategyColor = strategyUpper === 'PARALLEL' ? colors.cyan : colors.green;
        const teamFormatted = selected
          .map(
            (s) =>
              `${colors.bold}${s.agent.name}${colors.reset} ${colors.dim}(${s.roleRequest.role})${colors.reset}`,
          )
          .join(', ');
        const fanOutRationale = routing.fanOutAssessment
          ? routing.fanOutAssessment.admitted
            ? `Fan-out rationale: ${colors.green}admitted${colors.reset} — ${routing.fanOutAssessment.reasons.join('; ')}.`
            : `Fan-out rationale: ${colors.yellow}rejected${colors.reset} — ${routing.fanOutAssessment.reasons.join('; ')}.`
          : '';

        const primaryAssignmentCount = Math.max(
          1,
          selected.length || routing.teamSize || 1,
        );
        const calibrationByTaskType = this.usageCalibration.getTaskTypeCalibrations(
          tasks.map((task) => task.type),
        );
        const usageEstimate = ExecutionUsageEstimator.estimateRun({
          tasks,
          originalUserRequest: intent.goal,
          assignmentCounts: {
            [primaryTask.id]: primaryAssignmentCount,
          },
          calibrationByTaskType,
        });
        const usageByTask = new Map(
          usageEstimate.breakdown.map((estimate) => [estimate.taskId, estimate]),
        );

        const taskFormattedList = tasks.map((t, idx) => {
          const icon = theme.taskTypeIcon(t.type);
          const typeBadge = `${colors.brandLight}[${t.type.toUpperCase()}]${colors.reset}`;
          const titleStyled = `${colors.bold}${t.title}${colors.reset}`;
          const estimate = usageByTask.get(t.id);
          const tokenTag = estimate
            ? `${colors.dim}(~${formatApproxTokens(estimate.minTokens)}–${formatApproxTokens(estimate.maxTokens)} tokens, ${estimate.assignmentCount} baseline assignment${estimate.assignmentCount === 1 ? '' : 's'})${colors.reset}`
            : '';
          return `  ${colors.dim}${idx + 1}.${colors.reset} ${icon} ${typeBadge} ${titleStyled} ${tokenTag}`;
        });

        const plannerMeta = this.currentGraph.metadata?.planner as
          | PlannerProvenance
          | undefined;
        let plannerSource: string;
        if (plannerMeta?.source === 'semantic_model') {
          const providerLabel = plannerMeta.provider === 'custom' ? 'Custom' : 'Semantic';
          plannerSource = `${providerLabel} / ${plannerMeta.model || 'gpt-5.6-luna'}`;
        } else if (plannerMeta?.source === 'deterministic_decomposition') {
          plannerSource = `Deterministic decomposition${plannerMeta.fallbackReason ? ` (Fallback: ${plannerMeta.fallbackReason})` : ''}`;
        } else if (plannerMeta?.source === 'heuristic_fallback') {
          plannerSource = `Fallback / heuristic${plannerMeta.fallbackReason ? ` (${plannerMeta.fallbackReason})` : ''}`;
        } else if ((this.currentGraph.metadata as any)?.source === 'semantic') {
          plannerSource = `Semantic / ${(this.currentGraph.metadata as any)?.model || 'gpt-5.6-luna'}`;
        } else {
          plannerSource = `Fallback / heuristic${(this.currentGraph.metadata as any)?.fallbackReason ? ` (${(this.currentGraph.metadata as any).fallbackReason})` : ''}`;
        }

        const routerSource =
          (routing as any).source === 'openai'
            ? `OpenAI / ${this.config.router.model || 'gpt-5.6-luna'}`
            : (routing as any).source === 'adaptive'
              ? 'Adaptive (historical performance)'
              : `Static fallback${(routing as any).fallbackReason ? ` (Reason: ${(routing as any).fallbackReason})` : ''}`;

        const policyBadge = (routing as any).policyAdjustment
          ? `\n  ${colors.yellow}▲ Policy adjustment: ${(routing as any).policyAdjustment}${colors.reset}`
          : '';

        this.conversationState = 'AWAITING_PLAN_APPROVAL';

        return [
          `${colors.brand}✦ Plan Proposal${colors.reset}`,
          `  ${colors.dim}Planner:${colors.reset}  ${plannerSource}`,
          `  ${colors.dim}Router:${colors.reset}   ${routerSource}${policyBadge}`,
          `Understood. Recommended strategy: ${strategyColor}${colors.bold}${strategyUpper}${colors.reset} ${colors.dim}(Complexity: ${routing.complexity}, Risk: ${routing.risk})${colors.reset}.`,
          `Suggested team: ${teamFormatted}.`,
          fanOutRationale,
          `Estimated agent usage: ~${formatApproxTokens(usageEstimate.minTokens)}–${formatApproxTokens(usageEstimate.maxTokens)} tokens (expected ~${formatApproxTokens(usageEstimate.expectedTokens)}, confidence: ${usageEstimate.confidence}).`,
          `Baseline assignments: ${usageEstimate.baselineAssignments}. Retries, failover, emergent collaboration and provider-hidden context are not included.`,
          `Total of ${tasks.length} structured tasks:`,
          ...taskFormattedList,
          '',
          `  ${colors.green}●${colors.reset} ${colors.bold}Do you want me to execute?${colors.reset} ${colors.dim}(type "yes", "y" or "/approve" to start)${colors.reset}`,
        ].join('\n');
      }

      case 'revise_plan': {
        if (!this.currentGraph) {
          return 'No active plan to revise. Describe a goal first.';
        }
        this.conversationState = 'PLANNING';
        const goal: Goal = this.activeGoal ?? {
          id: `goal-${Date.now()}`,
          description: this.lastGoalDescription ?? 'Revised goal',
          repository: this.repoRoot,
          constraints: [],
          acceptanceCriteria: [],
          createdAt: new Date(),
        };
        this.activeGoal = goal;

        let revisedGraph: TaskGraph;
        if ('revise' in this.planner && typeof (this.planner as any).revise === 'function') {
          revisedGraph = await (this.planner as any).revise(
            this.currentGraph,
            goal,
            intent.revision,
          );
        } else {
          revisedGraph = await this.planner.plan(goal);
        }

        if (!this.activeRunId) {
          this.activeRunId = generateRunId();
        }
        this.currentGraph = await this.negotiator.negotiateGraph(revisedGraph, this.activeRunId);
        this.conversationState = 'AWAITING_PLAN_APPROVAL';

        const tasks = this.currentGraph.getAllTasks();
        const primaryTask = tasks[0];

        const availableAgentIds = await this.agentSelector.listAvailableAgentIds();
        const routingProposal = await this.router.route({
          task: primaryTask,
          availableAgents: availableAgentIds,
        });
        const routing = RouterQualityGuard.evaluate(routingProposal, {
          task: primaryTask,
          availableAgents: availableAgentIds,
        });

        const selected = await this.agentSelector.selectAgents(routing.roles, {
          selectionKey: `${this.repoRoot}:${primaryTask.id}`,
        });

        const strategyUpper = routing.strategy.toUpperCase();
        const strategyColor = strategyUpper === 'PARALLEL' ? colors.cyan : colors.green;
        const teamFormatted = selected
          .map(
            (s) =>
              `${colors.bold}${s.agent.name}${colors.reset} ${colors.dim}(${s.roleRequest.role})${colors.reset}`,
          )
          .join(', ');
        const fanOutRationale = routing.fanOutAssessment
          ? routing.fanOutAssessment.admitted
            ? `Fan-out rationale: ${colors.green}admitted${colors.reset} — ${routing.fanOutAssessment.reasons.join('; ')}.`
            : `Fan-out rationale: ${colors.yellow}rejected${colors.reset} — ${routing.fanOutAssessment.reasons.join('; ')}.`
          : '';

        const primaryAssignmentCount = Math.max(
          1,
          selected.length || routing.teamSize || 1,
        );
        const calibrationByTaskType = this.usageCalibration.getTaskTypeCalibrations(
          tasks.map((task) => task.type),
        );
        const usageEstimate = ExecutionUsageEstimator.estimateRun({
          tasks,
          originalUserRequest: goal.description,
          assignmentCounts: {
            [primaryTask.id]: primaryAssignmentCount,
          },
          calibrationByTaskType,
        });
        const usageByTask = new Map(
          usageEstimate.breakdown.map((estimate) => [estimate.taskId, estimate]),
        );

        const taskFormattedList = tasks.map((t, idx) => {
          const icon = theme.taskTypeIcon(t.type);
          const typeBadge = `${colors.brandLight}[${t.type.toUpperCase()}]${colors.reset}`;
          const titleStyled = `${colors.bold}${t.title}${colors.reset}`;
          const estimate = usageByTask.get(t.id);
          const tokenTag = estimate
            ? `${colors.dim}(~${formatApproxTokens(estimate.minTokens)}–${formatApproxTokens(estimate.maxTokens)} tokens, ${estimate.assignmentCount} baseline assignment${estimate.assignmentCount === 1 ? '' : 's'})${colors.reset}`
            : '';
          return `  ${colors.dim}${idx + 1}.${colors.reset} ${icon} ${typeBadge} ${titleStyled} ${tokenTag}`;
        });

        return [
          `${colors.brand}✦ Revised Plan${colors.reset} ${colors.dim}(Revision: ${intent.revision.details})${colors.reset}`,
          `Understood. Recommended strategy: ${strategyColor}${colors.bold}${strategyUpper}${colors.reset} ${colors.dim}(Complexity: ${routing.complexity}, Risk: ${routing.risk})${colors.reset}.`,
          `Suggested team: ${teamFormatted}.`,
          fanOutRationale,
          `Estimated agent usage: ~${formatApproxTokens(usageEstimate.minTokens)}–${formatApproxTokens(usageEstimate.maxTokens)} tokens (expected ~${formatApproxTokens(usageEstimate.expectedTokens)}, confidence: ${usageEstimate.confidence}).`,
          `Baseline assignments: ${usageEstimate.baselineAssignments}. Retries, failover, emergent collaboration and provider-hidden context are not included.`,
          `Total of ${tasks.length} structured tasks:`,
          ...taskFormattedList,
          '',
          `  ${colors.green}●${colors.reset} ${colors.bold}Do you want me to execute the revised plan?${colors.reset} ${colors.dim}(type "yes", "y" or "/approve" to start)${colors.reset}`,
        ].join('\n');
      }

      case 'approve_interaction': {
        const pending = this.interactionGateway.getPendingRequests();
        const target = intent.requestId
          ? pending.find((p) => p.id === intent.requestId)
          : pending[0];

        if (!target) {
          return 'No pending interaction found for approval.';
        }

        const scope = intent.scope ?? 'task';
        this.interactionGateway.resolve(target.id, 'allow', undefined, scope);
        return CockpitPanels.interactionResolved(target, 'allow', scope);
      }

      case 'deny_interaction': {
        const pending = this.interactionGateway.getPendingRequests();
        const target = intent.requestId
          ? pending.find((p) => p.id === intent.requestId)
          : pending[0];

        if (!target) {
          return 'No pending interaction found for denial.';
        }

        this.interactionGateway.resolve(target.id, 'deny', intent.reason, 'once');
        return CockpitPanels.interactionResolved(target, 'deny', 'once');
      }

      case 'inspect_pending_interactions': {
        const pending = this.interactionGateway.getPendingRequests();
        return this.operator.formatResponse(intent, { pending });
      }

      case 'stream_logs': {
        const active = this.activityTracker.getActive();
        if (active.length === 0) {
          return 'No active agent tasks currently streaming. Describe a goal or run a task to start streaming.';
        }
        // All active assignments for the requested task (or every active
        // assignment, task unspecified) -- several agents can legitimately
        // share one taskId, so this is never collapsed to a single match.
        const scoped = intent.taskId
          ? active.filter((a) => a.taskId.toLowerCase() === intent.taskId!.toLowerCase())
          : active;
        const pool = scoped.length > 0 ? scoped : active;

        return this.enterFocusMode(pool[0].assignmentId, pool);
      }

      case 'approve_plan': {
        // If there's an active interaction waiting for human approval, resolve it
        const pending = this.interactionGateway.getPendingRequests();
        if (pending.length > 0) {
          const target = pending[0];
          this.interactionGateway.resolve(target.id, 'allow', undefined, 'task');
          return CockpitPanels.interactionResolved(target, 'allow', 'task');
        }

        if (!this.currentGraph) {
          return 'No pending plan for approval. Describe an engineering goal in natural language to get started.';
        }

        const isFakeRequested = text.includes('--fake') || text.includes('fake');

        const approvedMsg = `\n  ${colors.brand}✦ ${colors.bold}TaskForge Execution${colors.reset}\n  ${colors.green}✔${colors.reset} ${colors.bold}Plan approved.${colors.reset} ${colors.dim}Starting execution...${colors.reset}\n`;
        this.viewport.writeUpper(approvedMsg);
        this.viewport.drawFooter('⚡ Executing plan...');

        const orchestrator = new RunOrchestrator({
          repoRoot: this.repoRoot,
          config: this.config,
          database: this.db,
          availabilityDatabase: this.availabilityDb,
          agentRegistry: this.agentRegistry,
          planner: this.planner,
          negotiator: this.negotiator,
          router: this.router,
          agentSelector: this.agentSelector,
          gitService: this.gitService,
          interactionGateway: this.interactionGateway,
          activityTracker: this.activityTracker,
          streamBus: this.streamBus,
          sessionRegistry: this.sessionRegistry,
          telemetryCollector: this.telemetry,
        });

        const isBackground =
          this.options.asyncExecution ??
          (this.viewport.isInteractive || text.includes('--bg') || text.includes('--async'));

        const runId = this.activeRunId ?? generateRunId();
        this.activeRunId = runId;
        this.conversationState = 'EXECUTING';

        if (isBackground) {
          const graphToRun = this.currentGraph;
          const goalDesc = this.lastGoalDescription ?? 'Approved execution';
          this.currentGraph = undefined;
          this.activeExecutionController = new AbortController();

          orchestrator
            .run(goalDesc, {
              runId,
              preplannedGraph: graphToRun,
              fakeFallback: isFakeRequested,
              abortSignal: this.activeExecutionController.signal,
              activityTracker: this.activityTracker,
              onProgress: (msg) => {
                this.viewport.writeUpper(theme.formatProgressMessage(msg));
              },
            })
            .then(async (result) => {
              this.activeExecutionController = undefined;
              this.conversationState =
                result.status === 'completed' &&
                this.deliveryService.getDelivery(result.runId)?.status === 'ready_to_apply'
                  ? 'DELIVERY_READY'
                  : 'IDLE';

              const efficiency = this.telemetry.getOrchestrationEfficiency(result.runId);
              const staffing = this.telemetry.getStaffingMetrics(result.runId);
              this.telemetry.recordRunMetrics({
                runId: result.runId,
                durationMs: result.durationMs,
                tasksCount: efficiency.taskCount,
                tasksCompleted: result.tasksCompleted,
                tasksFailed: result.tasksFailed,
                reworkCount: efficiency.reworkCount,
                escalationsCount:
                  staffing.collaborationApprovedCount +
                  staffing.collaborationRejectedCount +
                  staffing.collaborationDelayedCount,
              });

              const summary = await this.formatRunSummary(result);
              this.viewport.writeUpper(`\n${summary}\n`);
              this.viewport.drawFooter('');
            })
            .catch((err) => {
              this.activeExecutionController = undefined;
              this.conversationState = 'IDLE';
              if (abortSignal?.aborted || err.message?.includes('database is not open')) {
                return;
              }
              this.viewport.writeUpper(
                `\n  ${colors.red}✕ Run execution error:${colors.reset} ${err.message}\n`,
              );
              this.viewport.drawFooter('');
            });

          return [
            `\n  ${colors.brand}✦ ${colors.bold}TaskForge Execution${colors.reset}`,
            `  ${colors.green}✔${colors.reset} ${colors.bold}Plan approved.${colors.reset} Execution running in background (Run: ${runId}).`,
            `  ${colors.dim}REPL is active — submit new tasks to free agents, type /tasks, or /stream <task>.${colors.reset}\n`,
          ].join('\n');
        }

        try {
          const result = await orchestrator.run(
            this.lastGoalDescription ?? 'Approved execution',
            {
              runId,
              preplannedGraph: this.currentGraph,
              fakeFallback: isFakeRequested,
              abortSignal,
              activityTracker: this.activityTracker,
              onProgress: (msg) => {
                this.viewport.writeUpper(theme.formatProgressMessage(msg));
              },
            },
          );
          this.activeRunId = result.runId;
          this.currentGraph = undefined;
          this.conversationState =
            result.status === 'completed' &&
            this.deliveryService.getDelivery(result.runId)?.status === 'ready_to_apply'
              ? 'DELIVERY_READY'
              : 'IDLE';

          const efficiency = this.telemetry.getOrchestrationEfficiency(result.runId);
          const staffing = this.telemetry.getStaffingMetrics(result.runId);
          this.telemetry.recordRunMetrics({
            runId: result.runId,
            durationMs: result.durationMs,
            tasksCount: efficiency.taskCount,
            tasksCompleted: result.tasksCompleted,
            tasksFailed: result.tasksFailed,
            reworkCount: efficiency.reworkCount,
            escalationsCount:
              staffing.collaborationApprovedCount +
              staffing.collaborationRejectedCount +
              staffing.collaborationDelayedCount,
          });

          return await this.formatRunSummary(result);
        } catch (err) {
          this.conversationState = 'IDLE';
          return `${colors.red}✕ Error during plan execution: ${(err as Error).message}${colors.reset}\n${colors.dim}(Tip: type "yes --fake" to test with simulated agents if real agents are not configured with API keys)${colors.reset}`;
        }
      }

      case 'reject_plan': {
        const pending = this.interactionGateway.getPendingRequests();
        if (pending.length > 0) {
          const target = pending[0];
          this.interactionGateway.resolve(target.id, 'deny', intent.feedback, 'once');
          return CockpitPanels.interactionResolved(target, 'deny', 'once');
        }
        this.currentGraph = undefined;
        this.lastGoalDescription = undefined;
        return 'Plan discarded as requested.';
      }

      case 'general_query': {
        const commandLines = SLASH_COMMANDS.map(
          (command) =>
            `    ${colors.brand}${command.cmd.padEnd(12)}${colors.reset} ${command.desc}`,
        );
        return [
          `  ${colors.brand}✦ ${colors.bold}TaskForge Control Plane${colors.reset}`,
          `  ${colors.dim}Conversational control plane for autonomous coding-agent teams (Claude, Codex, Antigravity).${colors.reset}`,
          '',
          `  ${colors.bold}To start work, describe your engineering objective:${colors.reset}`,
          `    ${colors.cyan}›${colors.reset} investigate why checkout charges twice`,
          `    ${colors.cyan}›${colors.reset} create a JWT authentication endpoint`,
          `    ${colors.cyan}›${colors.reset} refactor API routes adding input validation`,
          '',
          `  ${colors.bold}Commands:${colors.reset}`,
          ...commandLines,
          '',
          `  ${colors.dim}Type / to browse the same command catalog interactively.${colors.reset}`,
        ].join('\n');
      }

      default:
        return `Command received: "${text}". Type /tasks, /agents or describe an objective in natural language.`;
    }
  }

  async start(): Promise<void> {
    const worktreeManager = new WorktreeManager(this.repoRoot);
    await worktreeManager.cleanOrphanedWorktreesAndBranches().catch(() => {});

    const gitStatus = await this.gitService.getStatus().catch(() => ({
      currentBranch: 'main',
    }));
    const repoName = path.basename(this.repoRoot);
    this.viewport.updateContext(repoName, gitStatus.currentBranch);

    const banner = await this.renderBanner();
    const inStream = this.options.input ?? process.stdin;
    const outStream = this.options.output ?? process.stdout;

    // Non-interactive fallback (tests, pipes, CI)
    if (!this.viewport.isInteractive) {
      this.viewport.writeUpper(banner);
      const rl = readline.createInterface({
        input: inStream,
        output: outStream,
        terminal: false,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit' || trimmed === 'quit') break;
        if (!trimmed) continue;
        const reply = await this.handleInput(trimmed);
        if (reply) {
          outStream.write(`${reply}\n`);
        }
      }
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      return;
    }

    // Interactive Terminal REPL with persistent bottom line starting with `> `
    this.viewport.init();
    this.viewport.writeUpper(banner);

    const inStreamAny = inStream as unknown as {
      setRawMode?: (mode: boolean) => void;
      resume?: () => void;
      pause?: () => void;
    };
    if (typeof inStreamAny.setRawMode === 'function') {
      try {
        inStreamAny.setRawMode(true);
      } catch {
        /* ignore */
      }
    }
    inStreamAny.resume?.();

    readline.emitKeypressEvents(inStream);

    let buffer = '';
    let cursorIndex = 0;
    const history: string[] = [];
    let historyIndex = -1;
    let savedInput = '';
    let isRunning = false;
    let activeAbortController: AbortController | undefined;
    let closed = false;
    let pendingResolve: ((line: string | null) => void) | null = null;
    let isPasting = false;
    let pastingBuffer = '';
    const pasteStore = new Map<string, string>();
    let pasteIdCounter = 0;

    const insertPastedText = (rawText: string) => {
      const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = normalized.split('\n');
      const lineCount = lines.length;
      const charCount = normalized.length;

      // Collapse large paste (>= 3 lines or >= 120 chars) into token
      if (lineCount >= 3 || (lineCount >= 2 && charCount >= 60) || charCount >= 150) {
        pasteIdCounter++;
        const placeholder =
          lineCount > 1
            ? `[Pasted text #${pasteIdCounter} +${lineCount} lines]`
            : `[Pasted text #${pasteIdCounter} +${charCount} chars]`;

        pasteStore.set(placeholder, normalized);
        buffer = buffer.slice(0, cursorIndex) + placeholder + buffer.slice(cursorIndex);
        cursorIndex += placeholder.length;
      } else {
        buffer = buffer.slice(0, cursorIndex) + normalized + buffer.slice(cursorIndex);
        cursorIndex += normalized.length;
      }
    };

    const expandPasteTokens = (text: string): string => {
      let result = text;
      for (const [placeholder, content] of pasteStore.entries()) {
        result = result.split(placeholder).join(content);
      }
      return result;
    };

    const readNextLine = (): Promise<string | null> => {
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (this.activeExecutionController) {
        this.activeExecutionController.abort();
        this.activeExecutionController = undefined;
      }
      process.removeListener('SIGINT', cleanup);
      process.removeListener('exit', cleanup);
      this.slashMenu.close();
      this.cockpitUnsubscribe?.();
      this.cockpitUnsubscribe = undefined;
      if (this.tickerTimer) {
        clearInterval(this.tickerTimer);
        this.tickerTimer = undefined;
      }
      this.viewport.cleanup();
      inStream.removeListener('keypress', onKeypress);
      if (typeof inStreamAny.setRawMode === 'function') {
        try {
          inStreamAny.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      try {
        inStreamAny.pause?.();
      } catch {
        /* ignore */
      }
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      worktreeManager.cleanOrphanedWorktreesAndBranches().catch(() => {});
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined) => {
      if (closed) return;

      // Bracketed paste detection
      if (str && str.includes('\x1b[200~') && str.includes('\x1b[201~')) {
        // eslint-disable-next-line no-control-regex
        const clean = str.replace(/\x1b\[20[01]~/g, '');
        insertPastedText(clean);
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }
      if (
        key?.name === 'paste-start' ||
        key?.sequence === '\x1b[200~' ||
        str === '\x1b[200~' ||
        (str && str.startsWith('\x1b[200~'))
      ) {
        isPasting = true;
        // eslint-disable-next-line no-control-regex
        pastingBuffer = str && str.startsWith('\x1b[200~') ? str.replace(/\x1b\[200~/g, '') : '';
        return;
      }
      if (
        key?.name === 'paste-end' ||
        key?.sequence === '\x1b[201~' ||
        str === '\x1b[201~' ||
        (str && str.includes('\x1b[201~'))
      ) {
        isPasting = false;
        if (str && str.includes('\x1b[201~')) {
          // eslint-disable-next-line no-control-regex
          pastingBuffer += str.replace(/\x1b\[20[01]~/g, '');
        }
        if (pastingBuffer.length > 0) {
          insertPastedText(pastingBuffer);
          pastingBuffer = '';
        }
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }
      if (isPasting) {
        if (key?.name === 'return' || key?.name === 'enter' || str === '\n' || str === '\r') {
          pastingBuffer += '\n';
          return;
        }
        if (str) {
          // eslint-disable-next-line no-control-regex
          const clean = str.replace(/\x1b\[20[01]~/g, '');
          pastingBuffer += clean;
        }
        return;
      }

      // Return / Enter: submit line OR insert newline on Shift/Meta/Ctrl+J
      if (
        key?.name === 'return' ||
        key?.name === 'enter' ||
        str === '\r' ||
        str === '\n' ||
        (key?.ctrl && key?.name === 'j')
      ) {
        // Shift+Enter / Alt+Enter / Meta+Enter: insert newline in prompt
        if (key?.shift || key?.meta) {
          buffer = buffer.slice(0, cursorIndex) + '\n' + buffer.slice(cursorIndex);
          cursorIndex++;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          return;
        }

        if (this.slashMenu.isOpen) {
          const selected = this.slashMenu.getSelected();
          if (selected && (buffer === '/' || !buffer.includes(' '))) {
            buffer = selected.cmd;
          }
          this.slashMenu.close();
        }

        const rawSubmitted = buffer;
        const submitted = expandPasteTokens(rawSubmitted);
        buffer = '';
        cursorIndex = 0;
        historyIndex = -1;
        savedInput = '';

        if (rawSubmitted.trim()) {
          history.push(rawSubmitted);
        }

        // Echo user prompt into the upper scrolling history
        if (rawSubmitted.includes('\n')) {
          const lines = rawSubmitted.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const prefix = i === 0 ? `${colors.bold}${colors.green}>${colors.reset} ` : '  ';
            this.viewport.writeUpper(`${prefix}${lines[i]}`);
          }
        } else {
          this.viewport.writeUpper(`${colors.bold}${colors.green}>${colors.reset} ${rawSubmitted}`);
        }

        const res = pendingResolve;
        pendingResolve = null;
        res?.(submitted);
        return;
      }

      // Fallback: If a multiline chunk is pasted without bracketed paste flags
      if (
        str &&
        str.length > 1 &&
        (str.includes('\n') || str.includes('\r')) &&
        !key?.ctrl &&
        !key?.meta
      ) {
        insertPastedText(str);
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // Tab shortcut: auto-fill /stream if prompt is empty and agents are actively working
      if (!this.slashMenu.isOpen && key?.name === 'tab' && buffer.trim().length === 0) {
        if (this.activityTracker.getActive().length > 0) {
          buffer = '/stream';
          cursorIndex = buffer.length;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          return;
        }
      }

      // Ctrl+C: Cancel active background execution, running operation, or exit safely
      if (key?.ctrl && key?.name === 'c') {
        if (this.activeExecutionController) {
          this.activeExecutionController.abort();
          this.activeExecutionController = undefined;
          this.viewport.writeUpper(
            `\n${colors.red}^C Plan execution cancelled by user.${colors.reset}\n`,
          );
          buffer = '';
          cursorIndex = 0;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          return;
        }

        if (isRunning && activeAbortController) {
          activeAbortController.abort();
          this.viewport.writeUpper(
            `\n${colors.red}^C Operation cancelled by user.${colors.reset}\n`,
          );
          buffer = '';
          cursorIndex = 0;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          return;
        }

        if (buffer.length > 0) {
          buffer = '';
          cursorIndex = 0;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          return;
        }

        const exitMsg = `\n${colors.brand}✦${colors.reset} Goodbye!\n`;
        this.viewport.writeUpper(exitMsg);
        cleanup();
        const res = pendingResolve;
        pendingResolve = null;
        res?.(null);
        if (!this.options.input) {
          process.exit(0);
        }
        return;
      }

      // Ctrl+D: Exit CLI when input is empty; delete char under cursor if not empty
      if (key?.ctrl && key?.name === 'd') {
        if (buffer.length === 0) {
          const exitMsg = `\n${colors.brand}✦${colors.reset} Goodbye!\n`;
          this.viewport.writeUpper(exitMsg);
          cleanup();
          const res = pendingResolve;
          pendingResolve = null;
          res?.(null);
          if (!this.options.input) {
            process.exit(0);
          }
          return;
        }

        if (cursorIndex < buffer.length) {
          buffer = buffer.slice(0, cursorIndex) + buffer.slice(cursorIndex + 1);
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          if (buffer.startsWith('/')) {
            this.slashMenu.update(buffer, false);
          } else {
            this.slashMenu.close();
          }
        }
        return;
      }

      // If an operation is actively running, ignore other key entries (except Ctrl+C above)
      if (isRunning) {
        return;
      }

      // Focus Mode raw shortcuts: while the prompt is empty and an assignment
      // is focused, 1-9 switch agent immediately and Esc returns to overview.
      // Every other case falls through to the existing line editor unchanged.
      if (
        this.viewport.handleFocusShortcut({
          str,
          key,
          buffer,
          focused: Boolean(this.focusedAssignmentId),
          onSwitch: (indexOneBased) => this.switchFocus(indexOneBased),
          onExit: () => this.exitFocusMode(),
        })
      ) {
        return;
      }

      // Slash menu navigation with Up / Down / Tab / Esc
      if (this.slashMenu.isOpen && key) {
        if (key.name === 'up') {
          this.slashMenu.selectPrev();
          return;
        }
        if (key.name === 'down') {
          this.slashMenu.selectNext();
          return;
        }
        if (key.name === 'tab') {
          const selected = this.slashMenu.getSelected();
          if (selected) {
            buffer = selected.cmd;
            cursorIndex = buffer.length;
            this.slashMenu.update(buffer);
            this.viewport.renderInputLine(buffer, cursorIndex, '');
          }
          return;
        }
        if (key.name === 'escape') {
          this.slashMenu.close();
          return;
        }
      }

      // Backspace
      if (key?.name === 'backspace') {
        if (cursorIndex > 0) {
          const beforeCursor = buffer.slice(0, cursorIndex);
          const pasteMatch = beforeCursor.match(/\[Pasted text #\d+ \+\d+ (?:lines|chars)\]$/);
          if (pasteMatch) {
            const token = pasteMatch[0];
            buffer = buffer.slice(0, cursorIndex - token.length) + buffer.slice(cursorIndex);
            cursorIndex -= token.length;
            pasteStore.delete(token);
          } else {
            buffer = buffer.slice(0, cursorIndex - 1) + buffer.slice(cursorIndex);
            cursorIndex--;
          }
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          if (buffer.startsWith('/')) {
            this.slashMenu.update(buffer, true);
          } else {
            this.slashMenu.close();
          }
        }
        return;
      }

      // Delete key
      if (key?.name === 'delete') {
        if (cursorIndex < buffer.length) {
          const afterCursor = buffer.slice(cursorIndex);
          const pasteMatch = afterCursor.match(/^\[Pasted text #\d+ \+\d+ (?:lines|chars)\]/);
          if (pasteMatch) {
            const token = pasteMatch[0];
            buffer = buffer.slice(0, cursorIndex) + buffer.slice(cursorIndex + token.length);
            pasteStore.delete(token);
          } else {
            buffer = buffer.slice(0, cursorIndex) + buffer.slice(cursorIndex + 1);
          }
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          if (buffer.startsWith('/')) {
            this.slashMenu.update(buffer, false);
          } else {
            this.slashMenu.close();
          }
        }
        return;
      }

      // Left arrow (with word jump support)
      if (key?.name === 'left') {
        if (key.meta || key.ctrl) {
          cursorIndex = findWordLeft(buffer, cursorIndex);
        } else if (cursorIndex > 0) {
          cursorIndex--;
        }
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // Right arrow (with word jump support)
      if (key?.name === 'right') {
        if (key.meta || key.ctrl) {
          cursorIndex = findWordRight(buffer, cursorIndex);
        } else if (cursorIndex < buffer.length) {
          cursorIndex++;
        }
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // Home / Ctrl+A
      if (key?.name === 'home' || (key?.ctrl && key?.name === 'a')) {
        cursorIndex = 0;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // End / Ctrl+E
      if (key?.name === 'end' || (key?.ctrl && key?.name === 'e')) {
        cursorIndex = buffer.length;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // Ctrl+U (delete to start of line)
      if (key?.ctrl && key?.name === 'u') {
        buffer = buffer.slice(cursorIndex);
        cursorIndex = 0;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        if (!buffer.startsWith('/')) this.slashMenu.close();
        return;
      }

      // Ctrl+K (delete to end of line)
      if (key?.ctrl && key?.name === 'k') {
        buffer = buffer.slice(0, cursorIndex);
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        if (!buffer.startsWith('/')) this.slashMenu.close();
        return;
      }

      // Ctrl+W (delete previous word)
      if (key?.ctrl && key?.name === 'w') {
        const newIdx = findWordLeft(buffer, cursorIndex);
        buffer = buffer.slice(0, newIdx) + buffer.slice(cursorIndex);
        cursorIndex = newIdx;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        if (!buffer.startsWith('/')) this.slashMenu.close();
        return;
      }

      // Up arrow: Command history previous
      if (key?.name === 'up') {
        if (history.length > 0) {
          if (historyIndex === -1) {
            savedInput = buffer;
            historyIndex = history.length - 1;
          } else if (historyIndex > 0) {
            historyIndex--;
          }
          buffer = history[historyIndex];
          cursorIndex = buffer.length;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
        }
        return;
      }

      // Down arrow: Command history next
      if (key?.name === 'down') {
        if (historyIndex !== -1) {
          if (historyIndex < history.length - 1) {
            historyIndex++;
            buffer = history[historyIndex];
          } else {
            historyIndex = -1;
            buffer = savedInput;
          }
          cursorIndex = buffer.length;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
        }
        return;
      }

      // Printable character entry
      if (str && !key?.ctrl && !key?.meta) {
        buffer = buffer.slice(0, cursorIndex) + str + buffer.slice(cursorIndex);
        cursorIndex += str.length;

        if (buffer.startsWith('/')) {
          this.slashMenu.update(buffer, false);
        } else {
          this.slashMenu.close();
        }

        this.viewport.renderInputLine(buffer, cursorIndex, '');
      }
    };

    inStream.on('keypress', onKeypress);

    process.on('SIGINT', cleanup);
    process.on('exit', cleanup);

    while (!closed) {
      this.viewport.renderInputLine(buffer, cursorIndex, '');
      const line = await readNextLine();
      if (line === null) break;

      const trimmed = line.trim();
      if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit' || trimmed === 'quit') {
        const exitMsg = `\n${colors.brand}✦${colors.reset} Goodbye!\n`;
        this.viewport.writeUpper(exitMsg);
        cleanup();
        if (!this.options.input) {
          process.exit(0);
        }
        break;
      }

      if (!trimmed) {
        continue;
      }

      isRunning = true;
      activeAbortController = new AbortController();
      this.viewport.renderInputLine('', 0, 'Thinking...');

      try {
        const reply = await this.handleInput(trimmed, activeAbortController.signal);
        if (reply) {
          this.viewport.writeUpper(`\n${reply}\n`);
        }
      } catch (err: unknown) {
        if (!activeAbortController.signal.aborted) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.viewport.writeUpper(`\n${colors.red}Error: ${errMsg}${colors.reset}\n`);
        }
      } finally {
        isRunning = false;
        activeAbortController = undefined;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
      }
    }

    cleanup();
    if (!this.options.input) {
      process.exit(0);
    }
  }

  public close(): void {
    if (this.activeExecutionController) {
      try {
        this.activeExecutionController.abort();
      } catch {
        // ignore
      }
      this.activeExecutionController = undefined;
    }
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = undefined;
    }
    this.focusUnsubscribe?.();
    this.focusUnsubscribe = undefined;
    this.cockpitUnsubscribe?.();
    this.cockpitUnsubscribe = undefined;
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
    if (this.availabilityDb !== this.db) {
      try {
        this.availabilityDb.close();
      } catch {
        // ignore if already closed
      }
    }
  }
}
