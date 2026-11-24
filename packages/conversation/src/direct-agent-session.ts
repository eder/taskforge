import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentActivityTracker, AgentRegistry } from '@taskforge/agents';
import { AgentDetector } from '@taskforge/agents';
import { ProcessRunner } from '@taskforge/execution';
import {
  type AgentAssignment,
  type AgentContext,
  type AgentStreamEvent,
  DEFAULT_OPENAI_BASE_URL,
  detectExecutionIntent,
} from '@taskforge/shared';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { colors } from './theme.js';
import { assessProblemAndSelectAgent } from './problem-size-router.js';
import {
  appendImageContextToPrompt,
  resolveFileMentionsInPrompt,
} from './file-mention-completer.js';
import type { DirectCheckpointManager } from './direct-checkpoint.js';
import type { DirectTelemetryStore } from './direct-telemetry.js';
import { formatProjectMemoryForPrompt } from './project-memory.js';
import type { SpecialtyRouter } from './specialty-router.js';
import type { LifecycleHookRunner } from './lifecycle-hooks.js';

export type DirectSessionEntry =
  | { seq?: number; kind: 'user'; text: string; timestamp: string }
  | {
      seq?: number;
      kind: 'agent';
      agentId: string;
      agentName: string;
      response: string;
      durationMs: number;
      filesChanged?: string[];
      timestamp: string;
    }
  | {
      seq?: number;
      kind: 'shell';
      command: string;
      exitCode: number;
      output: string;
      durationMs: number;
      timestamp: string;
    };

/**
 * Rolling multi-turn conversation memory shared across ALL agents (`@claude`,
 * `@codex`, `@agy`, `@all`) and direct `!shell` commands inside a REPL session.
 * Enables seamless cross-agent handoff without repeating context.
 */
export class DirectConversationMemory {
  private entries: DirectSessionEntry[] = [];
  private readonly maxEntries: number;
  private seq = 0;

  constructor(maxEntries = 24) {
    this.maxEntries = maxEntries;
  }

  public record(entry: DirectSessionEntry): number {
    this.seq += 1;
    const stamped: DirectSessionEntry = { ...entry, seq: this.seq };
    this.entries.push(stamped);
    if (this.entries.length > this.maxEntries) {
      if (this.maxEntries >= 12) {
        // Auto-compact oldest turns into a rolling summary instead of silently dropping decisions.
        this.compact(Math.max(6, Math.min(this.maxEntries - 1, Math.floor(this.maxEntries * 0.6))));
      } else {
        this.entries = this.entries.slice(-this.maxEntries);
      }
    }
    return this.seq;
  }

  /**
   * Condenses older conversation turns into a dense rolling summary entry while
   * keeping the most recent `keepRecent` entries verbatim.
   */
  public compact(keepRecent = 6): { compactedCount: number; remainingCount: number } {
    if (this.entries.length <= keepRecent + 1) {
      return { compactedCount: 0, remainingCount: this.entries.length };
    }
    const cutoff = this.entries.length - keepRecent;
    const older = this.entries.slice(0, cutoff);
    const recent = this.entries.slice(cutoff);

    const summaryBullets: string[] = [];
    for (const e of older) {
      if (e.kind === 'user') {
        summaryBullets.push(`- User asked: ${e.text.replace(/\s+/g, ' ').slice(0, 120)}`);
      } else if (e.kind === 'agent') {
        const files = e.filesChanged?.length ? ` [edited: ${e.filesChanged.slice(0, 4).join(', ')}]` : '';
        const lead = e.response.replace(/\s+/g, ' ').slice(0, 140);
        summaryBullets.push(`- ${e.agentName}${files}: ${lead}`);
      } else {
        summaryBullets.push(`- Shell \`${e.command.slice(0, 60)}\` (exit ${e.exitCode})`);
      }
    }

    const summaryEntry: DirectSessionEntry = {
      seq: older[older.length - 1]?.seq ?? this.seq,
      kind: 'agent',
      agentId: 'summary',
      agentName: 'Compacted Session Summary',
      response: summaryBullets.slice(-14).join('\n'),
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };
    this.entries = [summaryEntry, ...recent];
    return { compactedCount: older.length, remainingCount: this.entries.length };
  }

  public getSequence(): number {
    return this.seq;
  }

  public getEntries(): readonly DirectSessionEntry[] {
    return this.entries;
  }

  public clear(): void {
    this.entries = [];
    this.seq = 0;
  }

  public exportState(): { entries: DirectSessionEntry[]; seq: number } {
    return {
      entries: this.entries.map((e) => ({ ...e })),
      seq: this.seq,
    };
  }

  public restoreState(state: { entries: DirectSessionEntry[]; seq: number }): void {
    this.entries = Array.isArray(state.entries) ? state.entries.slice(-this.maxEntries) : [];
    const maxEntrySeq = this.entries.reduce((max, e) => Math.max(max, e.seq ?? 0), 0);
    this.seq = Math.max(typeof state.seq === 'number' ? state.seq : 0, maxEntrySeq);
  }

  public formatForPrompt(maxChars = 8000): string {
    return this.formatEntries(this.entries, maxChars);
  }

  /** Formats only entries recorded strictly after `sinceSeq` (and optionally up to `upToSeq`), used as delta context when resuming a native provider session. */
  public formatSince(sinceSeq: number, maxChars = 4000, upToSeq?: number): string {
    const delta = this.entries.filter((e) => {
      const s = e.seq ?? 0;
      return s > sinceSeq && (upToSeq === undefined || s <= upToSeq);
    });
    return this.formatEntries(delta, maxChars);
  }

  private formatEntries(list: readonly DirectSessionEntry[], maxChars: number): string {
    if (list.length === 0) return '';
    const blocks: string[] = [];
    let used = 0;

    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      let block = '';
      if (entry.kind === 'user') {
        block = `[User]\n${entry.text.slice(0, 1200)}`;
      } else if (entry.kind === 'agent') {
        const filesNote =
          entry.filesChanged && entry.filesChanged.length > 0
            ? `\n(Modified files: ${entry.filesChanged.join(', ')})`
            : '';
        block = `[${entry.agentName} (${entry.agentId})]\n${entry.response.slice(0, 2200)}${filesNote}`;
      } else {
        block = `[Shell: ${entry.command} (exit ${entry.exitCode})]\n${entry.output.slice(0, 1200)}`;
      }

      if (used + block.length + 2 > maxChars && blocks.length > 0) break;
      blocks.unshift(block);
      used += block.length + 2;
    }

    return blocks.join('\n\n');
  }
}

export interface DirectAgentTurnOutcome {
  agentId: string;
  agentName: string;
  success: boolean;
  response: string;
  durationMs: number;
  tokensUsed?: number;
  filesChanged: string[];
  error?: string;
  providerSessionId?: string;
  resumedSession?: boolean;
}

export interface CompetitiveEditCandidate {
  index: number;
  taskId: string;
  assignmentId: string;
  agentId: string;
  agentName: string;
  success: boolean;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  commitHash?: string;
  filesChanged: string[];
  diffStat: string;
  response: string;
  durationMs: number;
  tokensUsed?: number;
  checkPassed?: boolean;
  checkSummary?: string;
  error?: string;
}

export interface PendingCompetitiveEdit {
  id: string;
  prompt: string;
  baseCommit: string;
  candidates: CompetitiveEditCandidate[];
  recommendedIndex?: number;
}

export interface PendingPipelineFollowUp {
  implementerId: string;
  implementerName: string;
  reviewerId: string;
  reviewerName: string;
  originalPrompt: string;
  findings: string;
  filesChanged: string[];
}

export type DirectConsensusSynthesizer = (
  prompt: string,
  outcomes: DirectAgentTurnOutcome[],
) => Promise<string | undefined>;

export interface DirectRunnerOptions {
  repoRoot: string;
  agentRegistry: AgentRegistry;
  memory: DirectConversationMemory;
  timeoutMs?: number;
  onLiveLine?: (line: string) => void;
  gitService?: GitService;
  worktreeManager?: WorktreeManager;
  /** Optional checkpoint manager for instant `/undo` before direct-mode write turns. */
  checkpointManager?: DirectCheckpointManager;
  /** Optional live activity tracker so parallel direct turns animate the LiveTicker footer. */
  activityTracker?: AgentActivityTracker;
  /** Optional unified telemetry store for Direct Mode `/cost` & `/stats`. */
  directTelemetry?: DirectTelemetryStore;
  /** Optional specialty router to boost historically strong agents per domain. */
  specialtyRouter?: SpecialtyRouter;
  /** Optional deterministic lifecycle hook runner (`hooks.afterDirectEdit`). */
  hookRunner?: LifecycleHookRunner;
  /** Optional custom consensus synthesizer (overrides OpenAI lookup; great for deterministic tests). */
  consensusSynthesizer?: DirectConsensusSynthesizer;
  /** Optional OpenAI credentials used to synthesize Consensus & Divergences on `@all` multi-agent turns. */
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiModel?: string;
  /** Optional verification callback run on each candidate worktree during `@a @b --edit`. */
  verifyWorktree?: (worktreePath: string) => Promise<{ passed: boolean; summary: string }>;
  /** Project verification commands (used automatically during `@a @b --edit` when `verifyWorktree` is omitted). */
  verificationCommands?: string[];
  /** Invoked whenever memory or native provider session IDs change (used for SQLite persistence). */
  onStateChanged?: () => void;
}

function formatStreamLine(agentName: string, event: AgentStreamEvent): string | undefined {
  const tag = `${colors.dim}[${agentName}]${colors.reset}`;
  switch (event.type) {
    case 'file_read':
      return `  ${tag} ${colors.dim}Read ${event.path}${colors.reset}`;
    case 'file_edit':
      return `  ${tag} ${colors.cyan}Edit ${event.path}${colors.reset}`;
    case 'file_write':
      return `  ${tag} ${colors.cyan}Write ${event.path}${colors.reset}`;
    case 'command_started':
      return `  ${tag} ${colors.yellow}$ ${event.command.slice(0, 90)}${colors.reset}`;
    case 'tool_started':
      return `  ${tag} ${colors.dim}Tool: ${event.tool}${colors.reset}`;
    case 'status':
      return `  ${tag} ${colors.dim}${event.status.slice(0, 90)}${colors.reset}`;
    default:
      return undefined;
  }
}

async function snapshotDirtyFiles(repoRoot: string, gitService?: GitService): Promise<Set<string>> {
  try {
    const git = gitService ?? new GitService(repoRoot);
    if (!(await git.isGitRepo())) return new Set();
    const raw = await git.exec(['status', '--porcelain'], repoRoot);
    const files = new Set<string>();
    for (const line of raw.split('\n')) {
      const file = line.replace(/^\s*[MADRCU?!]{1,2}\s+/, '').trim();
      if (file) files.add(file);
    }
    return files;
  } catch {
    return new Set();
  }
}

/**
 * Executes direct agent turns (single or multi-agent parallel) and direct local
 * shell commands against the workspace, streaming live tool activity and
 * persisting shared multi-turn memory across providers.
 */
export class DirectAgentRunner {
  private readonly repoRoot: string;
  private readonly agentRegistry: AgentRegistry;
  private readonly memory: DirectConversationMemory;
  private readonly timeoutMs: number;
  private readonly onLiveLine?: (line: string) => void;
  private readonly gitService?: GitService;
  private readonly worktreeManager?: WorktreeManager;
  private readonly checkpointManager?: DirectCheckpointManager;
  private readonly activityTracker?: AgentActivityTracker;
  private readonly directTelemetry?: DirectTelemetryStore;
  private readonly specialtyRouter?: SpecialtyRouter;
  private readonly hookRunner?: LifecycleHookRunner;
  private readonly consensusSynthesizer?: DirectConsensusSynthesizer;
  private readonly openAiApiKey?: string;
  private readonly openAiBaseUrl: string;
  private readonly openAiModel: string;
  private readonly verifyWorktree?: (worktreePath: string) => Promise<{ passed: boolean; summary: string }>;
  private readonly verificationCommands: string[];
  private readonly onStateChanged?: () => void;
  /** Tracks each agent's latest native provider session/thread ID + memory watermark for zero-bloat follow-ups. */
  private readonly providerSessions = new Map<string, { sessionId: string; lastSeq: number }>();

  constructor(options: DirectRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.agentRegistry = options.agentRegistry;
    this.memory = options.memory;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.onLiveLine = options.onLiveLine;
    this.gitService = options.gitService;
    this.worktreeManager = options.worktreeManager;
    this.checkpointManager = options.checkpointManager;
    this.activityTracker = options.activityTracker;
    this.directTelemetry = options.directTelemetry;
    this.specialtyRouter = options.specialtyRouter;
    this.hookRunner = options.hookRunner;
    this.consensusSynthesizer = options.consensusSynthesizer;
    this.openAiApiKey = options.openAiApiKey;
    this.openAiBaseUrl = (options.openAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
    this.openAiModel = options.openAiModel ?? 'gpt-4o-mini';
    this.verifyWorktree = options.verifyWorktree;
    this.verificationCommands = (options.verificationCommands ?? []).filter((c) => c.trim().length > 0);
    this.onStateChanged = options.onStateChanged;
  }

  /** Clears native provider session handles (called on `/clear`). */
  public clearSessions(): void {
    this.providerSessions.clear();
    this.onStateChanged?.();
  }

  /** Exports tracked provider session handles for persistence across restarts. */
  public exportSessionMap(): Record<string, { sessionId: string; lastSeq: number }> {
    return Object.fromEntries(this.providerSessions.entries());
  }

  /** Restores persisted provider session handles on startup. */
  public restoreSessionMap(map: Record<string, { sessionId: string; lastSeq: number }>): void {
    this.providerSessions.clear();
    for (const [agentId, entry] of Object.entries(map ?? {})) {
      if (entry && typeof entry.sessionId === 'string' && entry.sessionId.trim()) {
        this.providerSessions.set(agentId, {
          sessionId: entry.sessionId.trim(),
          lastSeq: typeof entry.lastSeq === 'number' ? entry.lastSeq : 0,
        });
      }
    }
  }

  /** Exposes currently tracked native provider session IDs (useful for diagnostics/tests). */
  public getProviderSessionId(agentId: string): string | undefined {
    return this.providerSessions.get(agentId)?.sessionId;
  }

  public async runShellCommand(command: string, abortSignal?: AbortSignal): Promise<string> {
    const start = Date.now();
    this.onLiveLine?.(`\n  ${colors.cyan}$ ${command}${colors.reset}\n`);
    const result = await ProcessRunner.run({
      command: process.env.SHELL || '/bin/sh',
      args: ['-lc', command],
      cwd: this.repoRoot,
      timeoutMs: Math.min(this.timeoutMs, 120_000),
      abortSignal,
    });
    const durationMs = Date.now() - start;
    const combined = [result.stdout, result.stderr].filter((s) => s.trim()).join('\n').trim();
    const lines = combined ? combined.split('\n') : [];
    const preview =
      lines.length > 60
        ? [...lines.slice(0, 20), `... (${lines.length - 50} lines omitted) ...`, ...lines.slice(-30)].join('\n')
        : combined;

    this.memory.record({
      kind: 'shell',
      command,
      exitCode: result.exitCode,
      output: preview || '(no output)',
      durationMs,
      timestamp: new Date().toISOString(),
    });
    this.onStateChanged?.();

    const badge =
      result.exitCode === 0
        ? `${colors.green}✔ exit 0${colors.reset}`
        : `${colors.red}✖ exit ${result.exitCode}${colors.reset}`;
    const secs = `${(durationMs / 1000).toFixed(1)}s`;
    return [
      `${colors.brand}✦ ${colors.bold}Shell${colors.reset} ${colors.dim}${command}${colors.reset}  ${badge} ${colors.dim}(${secs})${colors.reset}`,
      preview
        ? preview
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n')
        : `  ${colors.dim}(no output)${colors.reset}`,
    ].join('\n');
  }

  public async resolveTargets(
    targets: 'all' | 'smart' | string[],
    prompt = '',
    mentionedFiles: string[] = [],
  ): Promise<{
    adapters: AgentAdapter[];
    unavailable: string[];
    selectionReason?: string;
  }> {
    if (targets === 'all' || targets === 'smart') {
      const reports = await AgentDetector.detect(this.agentRegistry.list());
      const ready = reports
        .filter((r) => r.ready)
        .map((r) => this.agentRegistry.get(r.id))
        .filter((a): a is AgentAdapter => Boolean(a));
      if (targets === 'all' || ready.length <= 1) {
        return { adapters: ready, unavailable: [] };
      }
      const intent = detectExecutionIntent(prompt);
      const readyIds = ready.map((a) => a.id);
      const learned = this.specialtyRouter?.recommendForTask(prompt, readyIds, mentionedFiles);
      const rec = assessProblemAndSelectAgent({
        text: prompt,
        mentionedFiles,
        availableAgents: readyIds,
        explicitAgentId: learned?.agentId,
      });
      // For large read-only questions, fan out to top 2 complementary agents;
      // for small/medium or write tasks, pick the single best-suited agent.
      const chosenIds =
        rec.recommendMultiAgent && !intent.mutationAllowed
          ? rec.recommendedAgents.slice(0, 2)
          : rec.primaryAgent
            ? [rec.primaryAgent]
            : [ready[0].id];
      const chosen = chosenIds
        .map((id) => ready.find((a) => a.id === id))
        .filter((a): a is AgentAdapter => Boolean(a));
      return {
        adapters: chosen,
        unavailable: [],
        selectionReason: learned ? learned.reason : rec.reason,
      };
    }

    const adapters: AgentAdapter[] = [];
    const unavailable: string[] = [];
    for (const id of targets) {
      const adapter = this.agentRegistry.get(id);
      if (!adapter) {
        unavailable.push(`${id} (not registered)`);
        continue;
      }
      const detected = await adapter.detect();
      if (!detected) {
        unavailable.push(`${adapter.name} (${id} not ready)`);
        continue;
      }
      adapters.push(adapter);
    }
    return { adapters, unavailable };
  }

  public async runAgents(
    targets: 'all' | 'smart' | string[],
    rawPrompt: string,
    options: { priorContext?: string; abortSignal?: AbortSignal; autoReason?: string } = {},
  ): Promise<{ formatted: string; outcomes: DirectAgentTurnOutcome[] }> {
    const resolvedMentions = resolveFileMentionsInPrompt(rawPrompt, this.repoRoot);
    const prompt = appendImageContextToPrompt(resolvedMentions.cleanedPrompt, resolvedMentions.images);
    const durableMemory = formatProjectMemoryForPrompt(this.repoRoot);
    const combinedPriorContext = [durableMemory, options.priorContext].filter(Boolean).join('\n\n') || undefined;
    const { adapters, unavailable, selectionReason } = await this.resolveTargets(
      targets,
      resolvedMentions.cleanedPrompt,
      resolvedMentions.files,
    );
    if (adapters.length === 0) {
      const detail =
        unavailable.length > 0
          ? `Unavailable: ${unavailable.join(', ')}.`
          : 'No ready agents detected (check /agents or /health).';
      return {
        formatted: `${colors.red}✖ Cannot run direct agent turn.${colors.reset} ${detail}`,
        outcomes: [],
      };
    }

    const isMultiAgent = adapters.length > 1;
    const intent = detectExecutionIntent(prompt);
    // Parallel multi-agent turns on the live workspace MUST stay read-only so two
    // agents never overwrite each other's files. Single-agent turns have full
    // direct workspace parity (read-only for questions, writable for actions).
    const mutationAllowed = !isMultiAgent && intent.mutationAllowed;
    const historySnapshot = this.memory.formatForPrompt();
    const seqBeforeCurrentUser = this.memory.getSequence();
    const beforeDirty = mutationAllowed ? await snapshotDirtyFiles(this.repoRoot, this.gitService) : new Set<string>();
    const preTurnCheckpoint =
      mutationAllowed && this.checkpointManager
        ? await this.checkpointManager.capture(prompt, adapters[0].id)
        : undefined;

    this.memory.record({
      kind: 'user',
      text: prompt,
      timestamp: new Date().toISOString(),
    });

    const headerTargets = adapters.map((a) => `${colors.bold}${a.name}${colors.reset}`).join(', ');
    const modeLabel = isMultiAgent
      ? 'parallel read-only'
      : mutationAllowed
        ? 'direct workspace'
        : 'read-only';
    const effectiveReason = options.autoReason ?? selectionReason;
    const filesHint =
      resolvedMentions.files.length > 0
        ? ` · files: ${resolvedMentions.files.slice(0, 3).join(', ')}`
        : '';
    this.onLiveLine?.(
      `\n  ${colors.brand}✦${colors.reset} ${options.autoReason ? `${colors.dim}Auto →${colors.reset} ` : ''}${headerTargets} ${colors.dim}(${modeLabel}${effectiveReason ? ` · ${effectiveReason}` : ''}${filesHint})${colors.reset}\n`,
    );

    const streamedTextByAgent = new Map<string, string>();

    const runOne = async (adapter: AgentAdapter): Promise<DirectAgentTurnOutcome> => {
      const start = Date.now();
      const prevSession = this.providerSessions.get(adapter.id);

      const invoke = async (useNativeResume: boolean) => {
        const assignmentId = `direct-${adapter.id}-${randomUUID().slice(0, 8)}`;
        const assignment: AgentAssignment = {
          id: assignmentId,
          taskId: 'DIRECT',
          agentId: adapter.id,
          role: mutationAllowed ? 'implementer' : 'researcher',
          objective: prompt,
          status: 'running',
        };
        const lastSeen = { line: '', streamed: '' };
        let startedTextStream = false;
        const resumeId = useNativeResume ? prevSession?.sessionId : undefined;
        // When resuming a native provider session, pass ONLY delta turns from other
        // agents / `!shell` since this agent's last turn (excluding the current prompt).
        const effectiveHistory = resumeId
          ? this.memory.formatSince(prevSession!.lastSeq, 4000, seqBeforeCurrentUser)
          : historySnapshot;
        const context: AgentContext = {
          worktreePath: this.repoRoot,
          originalUserRequest: prompt,
          priorContext: combinedPriorContext,
          conversationHistory: effectiveHistory || undefined,
          directMode: true,
          persistProviderSession: true,
          ...(resumeId ? { providerSessionId: resumeId } : {}),
          mutationAllowed,
          timeoutMs: this.timeoutMs,
          abortSignal: options.abortSignal,
          assignment,
          task: {
            objective: prompt,
            allowedScope: mutationAllowed ? ['**'] : [],
            forbiddenChanges: mutationAllowed ? [] : ['*'],
            acceptanceCriteria: ['Answer or complete the user request accurately'],
            dependencies: [],
          },
          onStreamEvent: (ev) => {
            if (ev.type === 'file_read' || ev.type === 'file_edit' || ev.type === 'file_write') {
              this.activityTracker?.updateStatus(assignmentId, `${ev.type.replace('_', ' ')} ${ev.path}`);
            } else if (ev.type === 'command_started') {
              this.activityTracker?.updateStatus(assignmentId, `$ ${ev.command.slice(0, 40)}`);
            }
            if (!isMultiAgent && ev.type === 'agent_message' && this.onLiveLine && ev.text) {
              const incoming = ev.text;
              // Skip duplicate final-message echo if the exact text was already streamed live.
              if (
                lastSeen.streamed.trim().length > 0 &&
                (incoming.trim() === lastSeen.streamed.trim() ||
                  lastSeen.streamed.endsWith(incoming))
              ) {
                return;
              }
              if (!startedTextStream) {
                startedTextStream = true;
                this.onLiveLine('\n');
              }
              // Delta chunks vs complete paragraph blocks
              const chunkToPrint =
                incoming.startsWith(lastSeen.streamed) && lastSeen.streamed.length > 0
                  ? incoming.slice(lastSeen.streamed.length)
                  : incoming;
              if (chunkToPrint) {
                lastSeen.streamed += chunkToPrint;
                streamedTextByAgent.set(adapter.id, lastSeen.streamed);
                this.onLiveLine(chunkToPrint);
              }
              return;
            }
            const line = formatStreamLine(adapter.name, ev);
            if (line && line !== lastSeen.line) {
              lastSeen.line = line;
              if (startedTextStream) {
                this.onLiveLine?.('\n');
                startedTextStream = false;
              }
              this.onLiveLine?.(`${line}\n`);
            }
          },
        };
        const startedAt = new Date();
        this.activityTracker?.register({
          assignmentId,
          taskId: 'DIRECT',
          taskTitle: prompt.slice(0, 60),
          agentId: adapter.id,
          agentName: adapter.name,
          role: assignment.role,
          status: isMultiAgent ? 'parallel direct analysis' : mutationAllowed ? 'editing workspace' : 'thinking',
          startedAt,
          lastActiveAt: startedAt,
        });
        try {
          const res = await adapter.execute(assignment, context);
          if (startedTextStream && !lastSeen.streamed.endsWith('\n')) {
            this.onLiveLine?.('\n');
          }
          return res;
        } finally {
          this.activityTracker?.completeAssignment(assignmentId);
        }
      };

      try {
        let resumedSession = Boolean(prevSession?.sessionId);
        let res = await invoke(resumedSession);
        // If resuming a stale/expired provider session failed, transparently fall back
        // once to a fresh session with full shared memory so the user turn never breaks.
        if (!res.success && resumedSession) {
          this.providerSessions.delete(adapter.id);
          resumedSession = false;
          res = await invoke(false);
        }
        const durationMs = res.durationMs || Date.now() - start;
        const response = (res.output || res.message || '').trim();
        return {
          agentId: adapter.id,
          agentName: adapter.name,
          success: res.success,
          response: response || (res.success ? '(completed with no text output)' : 'Execution failed'),
          durationMs,
          tokensUsed: res.usage?.totalTokens,
          filesChanged: [],
          error: res.success ? undefined : res.message || 'Execution failed',
          providerSessionId: res.providerSessionId ?? (resumedSession ? prevSession?.sessionId : undefined),
          resumedSession,
        };
      } catch (err) {
        return {
          agentId: adapter.id,
          agentName: adapter.name,
          success: false,
          response: '',
          durationMs: Date.now() - start,
          filesChanged: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const outcomes = await Promise.all(adapters.map((adapter) => runOne(adapter)));

    let savedCheckpointId: string | undefined;
    if (mutationAllowed && outcomes.length === 1) {
      const afterDirty = await snapshotDirtyFiles(this.repoRoot, this.gitService);
      // Detect both newly dirty files AND already-dirty files modified again during the turn.
      const changedFiles = [...afterDirty].filter((f) => !beforeDirty.has(f));
      if (changedFiles.length === 0 && preTurnCheckpoint) {
        const git = this.gitService ?? new GitService(this.repoRoot);
        const diffSinceCkpt = await git
          .exec(['diff', '--name-only', preTurnCheckpoint.treeHash], this.repoRoot)
          .catch(() => '');
        const modifiedSinceCkpt = diffSinceCkpt
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        outcomes[0].filesChanged = modifiedSinceCkpt;
      } else {
        outcomes[0].filesChanged = changedFiles;
      }
      if (preTurnCheckpoint) {
        if (outcomes[0].filesChanged.length > 0) {
          this.checkpointManager?.annotateFilesTouched(preTurnCheckpoint.id, outcomes[0].filesChanged);
          savedCheckpointId = preTurnCheckpoint.id;
        } else {
          await this.checkpointManager?.discard(preTurnCheckpoint.id);
        }
      }
    }

    for (const outcome of outcomes) {
      this.directTelemetry?.record({
        agentId: outcome.agentId,
        agentName: outcome.agentName,
        category: 'direct',
        prompt: resolvedMentions.cleanedPrompt,
        files: [...resolvedMentions.files, ...outcome.filesChanged],
        success: outcome.success,
        durationMs: outcome.durationMs,
        tokensUsed: outcome.tokensUsed,
      });
      let recordedSeq = this.memory.getSequence();
      if (outcome.response) {
        recordedSeq = this.memory.record({
          kind: 'agent',
          agentId: outcome.agentId,
          agentName: outcome.agentName,
          response: outcome.response,
          durationMs: outcome.durationMs,
          filesChanged: outcome.filesChanged,
          timestamp: new Date().toISOString(),
        });
      }
      if (outcome.success && outcome.providerSessionId) {
        this.providerSessions.set(outcome.agentId, {
          sessionId: outcome.providerSessionId,
          lastSeq: recordedSeq,
        });
      }
    }
    this.onStateChanged?.();

    let hookNote = '';
    if (mutationAllowed && outcomes[0]?.filesChanged.length > 0 && this.hookRunner) {
      const hookRes = await this.hookRunner.runHook('afterDirectEdit', {
        TASKFORGE_CHANGED_FILES: outcomes[0].filesChanged.join(' '),
      });
      if (hookRes.ran) {
        hookNote =
          hookRes.exitCode === 0
            ? `\n  ${colors.green}✔${colors.reset} ${colors.dim}Hook afterDirectEdit (${hookRes.command}) passed.${colors.reset}`
            : `\n  ${colors.yellow}⚠${colors.reset} ${colors.dim}Hook afterDirectEdit exited ${hookRes.exitCode}: ${hookRes.output?.slice(0, 140) ?? ''}${colors.reset}`;
      }
    }

    const sections: string[] = [];
    if (unavailable.length > 0) {
      sections.push(`  ${colors.yellow}⚠ Skipped unavailable:${colors.reset} ${unavailable.join(', ')}`);
    }
    if (isMultiAgent && intent.mutationAllowed) {
      sections.push(
        `  ${colors.dim}Note: multi-agent direct turns run read-only so agents do not overwrite each other. Use @codex @agy --edit <task> for isolated competitive worktrees, or a single @agent to edit directly.${colors.reset}`,
      );
    }

    for (const outcome of outcomes) {
      const secs = `${(outcome.durationMs / 1000).toFixed(1)}s`;
      const tokensNote =
        outcome.tokensUsed && outcome.tokensUsed > 0
          ? ` · ${outcome.tokensUsed.toLocaleString('en-US')} tokens`
          : '';
      const sessionNote = outcome.resumedSession ? ' · ↻ resumed' : '';
      const statusBadge = outcome.success
        ? `${colors.green}✔${colors.reset}`
        : `${colors.red}✖${colors.reset}`;
      const header = `${statusBadge} ${colors.brand}${colors.bold}${outcome.agentName}${colors.reset} ${colors.dim}(${outcome.agentId} · ${secs}${tokensNote}${sessionNote})${colors.reset}`;
      const alreadyStreamed =
        !isMultiAgent &&
        outcome.success &&
        (streamedTextByAgent.get(outcome.agentId)?.trim() ?? '') === outcome.response.trim() &&
        outcome.response.trim().length > 0;
      const body = outcome.success
        ? alreadyStreamed
          ? ''
          : outcome.response
        : `${colors.red}${outcome.error || outcome.response}${colors.reset}`;
      const filesBlock =
        outcome.filesChanged.length > 0
          ? `\n  ${colors.cyan}Modified files:${colors.reset} ${outcome.filesChanged.join(', ')}${savedCheckpointId ? `\n  ${colors.dim}↻ Checkpoint saved (${savedCheckpointId}) — type /undo or "desfaz" to revert.${colors.reset}` : ''}${hookNote}`
          : '';
      sections.push(body ? `${header}\n${body}${filesBlock}` : `${header}${filesBlock}`);
    }

    // Automatic Consensus & Divergences synthesis whenever >= 2 agents succeed in parallel.
    const successfulOutcomes = outcomes.filter((o) => o.success && o.response.trim().length > 0);
    if (isMultiAgent && successfulOutcomes.length >= 2) {
      const synthesis = await this.synthesizeConsensus(prompt, successfulOutcomes);
      if (synthesis) {
        sections.push(
          `${colors.brand}✦ ${colors.bold}Consensus & Divergences${colors.reset}\n${synthesis}`,
        );
      }
    }

    return {
      formatted: sections.join(`\n\n${colors.darkGray}${'─'.repeat(60)}${colors.reset}\n\n`),
      outcomes,
    };
  }

  /**
   * Produces a concise Consensus & Divergences synthesis across >= 2 parallel
   * agent answers. Uses an injected synthesizer or OpenAI when available, with
   * a fast, deterministic local comparison fallback when offline.
   */
  public async synthesizeConsensus(
    prompt: string,
    outcomes: DirectAgentTurnOutcome[],
  ): Promise<string | undefined> {
    if (outcomes.length < 2) return undefined;

    if (this.consensusSynthesizer) {
      try {
        const custom = await this.consensusSynthesizer(prompt, outcomes);
        if (custom && custom.trim()) return custom.trim();
      } catch {
        // fall through to deterministic summary
      }
    }

    if (this.openAiApiKey && !process.env.VITEST) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(`${this.openAiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.openAiApiKey}`,
            },
            body: JSON.stringify({
              model: this.openAiModel,
              temperature: 0.2,
              max_tokens: 450,
              messages: [
                {
                  role: 'system',
                  content:
                    'You compare parallel answers from multiple coding agents on the same question. Reply in the SAME language as the user question with two short bullet sections: "Consensus:" (what all agents agree on) and "Divergences / Unique points:" (where they disagree or what only one agent caught). Keep it crisp (max 8 bullets total).',
                },
                {
                  role: 'user',
                  content: [
                    `User question:\n${prompt.slice(0, 800)}`,
                    ...outcomes.map(
                      (o) => `\n--- ${o.agentName} (${o.agentId}) ---\n${o.response.slice(0, 2500)}`,
                    ),
                  ].join('\n'),
                },
              ],
            }),
            signal: controller.signal,
          });
          if (response.ok) {
            const json = (await response.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const text = json.choices?.[0]?.message?.content?.trim();
            if (text) return text;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // fall through to deterministic comparison
      }
    }

    return buildDeterministicConsensusFallback(outcomes);
  }

  /**
   * Runs 2+ agents competitively in isolated git worktrees on the same edit
   * task (`@codex @agy --edit <task>` or `@all --edit <task>`), compares their
   * diffs and optional check results side-by-side, and returns a
   * `PendingCompetitiveEdit` so the user can apply the winner with 1 Enter.
   */
  public async runCompetitiveEdit(
    targets: 'all' | 'smart' | string[],
    prompt: string,
    options: { priorContext?: string; abortSignal?: AbortSignal } = {},
  ): Promise<{ formatted: string; pending?: PendingCompetitiveEdit }> {
    const { adapters, unavailable } = await this.resolveTargets(targets, prompt);
    if (adapters.length === 0) {
      const detail =
        unavailable.length > 0
          ? `Unavailable: ${unavailable.join(', ')}.`
          : 'No ready agents detected (check /agents or /health).';
      return { formatted: `${colors.red}✖ Cannot run competitive edit.${colors.reset} ${detail}` };
    }

    const git = this.gitService ?? new GitService(this.repoRoot);
    if (!(await git.isGitRepo())) {
      return {
        formatted: `${colors.red}✖ Competitive multi-agent --edit requires a git repository (isolated worktrees).${colors.reset}`,
      };
    }

    const wtManager = this.worktreeManager ?? new WorktreeManager(this.repoRoot);
    const baseCommit = await git.getHeadCommit();
    const competeId = `compete-${Date.now().toString(36)}`;
    const historySnapshot = this.memory.formatForPrompt();

    this.memory.record({
      kind: 'user',
      text: `[competitive --edit] ${prompt}`,
      timestamp: new Date().toISOString(),
    });

    const headerTargets = adapters.map((a) => `${colors.bold}${a.name}${colors.reset}`).join(' vs ');
    this.onLiveLine?.(
      `\n  ${colors.brand}✦${colors.reset} Competitive Edit: ${headerTargets} ${colors.dim}(isolated worktrees from ${baseCommit.slice(0, 7)})${colors.reset}\n`,
    );

    const runCandidate = async (adapter: AgentAdapter, idx: number): Promise<CompetitiveEditCandidate> => {
      const start = Date.now();
      const taskId = `COMPETE-${idx + 1}`;
      const assignmentId = `${competeId}-${adapter.id}-${idx + 1}`;
      const wt = await wtManager.createWorktree(taskId, assignmentId, baseCommit);
      const assignment: AgentAssignment = {
        id: assignmentId,
        taskId,
        agentId: adapter.id,
        role: 'implementer',
        objective: prompt,
        status: 'running',
      };
      const lastSeen = { line: '' };
      const context: AgentContext = {
        worktreePath: wt.path,
        originalUserRequest: prompt,
        priorContext: options.priorContext,
        conversationHistory: historySnapshot || undefined,
        directMode: true,
        mutationAllowed: true,
        timeoutMs: this.timeoutMs,
        abortSignal: options.abortSignal,
        assignment,
        task: {
          objective: prompt,
          allowedScope: ['**'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Complete the user edit cleanly in this isolated worktree'],
          dependencies: [],
        },
        onStreamEvent: (ev) => {
          const line = formatStreamLine(`${adapter.name}#${idx + 1}`, ev);
          if (line && line !== lastSeen.line) {
            lastSeen.line = line;
            this.onLiveLine?.(`${line}\n`);
          }
        },
      };

      try {
        const res = await adapter.execute(assignment, context);
        const durationMs = res.durationMs || Date.now() - start;
        // Ensure any uncommitted edits left by custom/mock adapters are committed in the candidate worktree.
        const wtGit = new GitService(wt.path);
        let commitHash = res.commitHash;
        try {
          const st = await wtGit.getStatus(wt.path);
          if (!st.isClean) {
            commitHash = await wtGit.stageAndCommit(
              `compete(${adapter.id}): ${prompt.slice(0, 60)}`,
              wt.path,
            );
          } else if (!commitHash) {
            commitHash = st.headCommit;
          }
        } catch {
          // ignore
        }

        let filesChanged: string[] = [];
        let diffStat = '';
        if (commitHash && commitHash !== baseCommit) {
          const namesRaw = await wtGit
            .exec(['diff', '--name-only', `${baseCommit}..${commitHash}`], wt.path)
            .catch(() => '');
          filesChanged = namesRaw.split('\n').map((l) => l.trim()).filter(Boolean);
          diffStat = await wtGit
            .exec(['diff', '--stat', `${baseCommit}..${commitHash}`], wt.path)
            .catch(() => '');
        }

        let checkPassed: boolean | undefined;
        let checkSummary: string | undefined;
        if (res.success && filesChanged.length > 0) {
          if (this.verifyWorktree) {
            try {
              const check = await this.verifyWorktree(wt.path);
              checkPassed = check.passed;
              checkSummary = check.summary;
            } catch (err) {
              checkPassed = false;
              checkSummary = err instanceof Error ? err.message : String(err);
            }
          } else if (this.verificationCommands.length > 0) {
            const cmd = this.verificationCommands[0];
            try {
              const checkRes = await ProcessRunner.run({
                command: process.env.SHELL || '/bin/sh',
                args: ['-lc', cmd],
                cwd: wt.path,
                timeoutMs: Math.min(this.timeoutMs, 120_000),
                abortSignal: options.abortSignal,
              });
              checkPassed = checkRes.exitCode === 0;
              const combined = [checkRes.stdout, checkRes.stderr].filter((s) => s.trim()).join('\n').trim();
              checkSummary = combined.split('\n').filter(Boolean).slice(-1)[0] || `exit ${checkRes.exitCode}`;
            } catch (err) {
              checkPassed = false;
              checkSummary = err instanceof Error ? err.message : String(err);
            }
          }
        }

        return {
          index: idx + 1,
          taskId,
          assignmentId,
          agentId: adapter.id,
          agentName: adapter.name,
          success: res.success,
          worktreePath: wt.path,
          branchName: wt.branchName,
          baseCommit,
          commitHash,
          filesChanged,
          diffStat: diffStat.trim(),
          response: (res.output || res.message || '').trim(),
          durationMs,
          tokensUsed: res.usage?.totalTokens,
          checkPassed,
          checkSummary,
          error: res.success ? undefined : res.message || 'Execution failed',
        };
      } catch (err) {
        return {
          index: idx + 1,
          taskId,
          assignmentId,
          agentId: adapter.id,
          agentName: adapter.name,
          success: false,
          worktreePath: wt.path,
          branchName: wt.branchName,
          baseCommit,
          filesChanged: [],
          diffStat: '',
          response: '',
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const candidates = await Promise.all(adapters.map((adapter, idx) => runCandidate(adapter, idx)));

    // Pick recommended winner: produced changes + succeeded + checks passed (if run) + fastest
    const viable = candidates
      .filter((c) => c.success && c.filesChanged.length > 0 && c.checkPassed !== false)
      .sort((a, b) => {
        const aCheck = a.checkPassed === true ? 1 : 0;
        const bCheck = b.checkPassed === true ? 1 : 0;
        if (aCheck !== bCheck) return bCheck - aCheck;
        return a.durationMs - b.durationMs;
      });
    const recommendedIndex = viable[0]?.index;

    const pending: PendingCompetitiveEdit = {
      id: competeId,
      prompt,
      baseCommit,
      candidates,
      recommendedIndex,
    };

    const sections: string[] = [
      `${colors.brand}✦ ${colors.bold}Competitive Edit Comparison${colors.reset} ${colors.dim}(${candidates.length} isolated worktrees)${colors.reset}`,
    ];
    if (unavailable.length > 0) {
      sections.push(`  ${colors.yellow}⚠ Skipped unavailable:${colors.reset} ${unavailable.join(', ')}`);
    }

    for (const c of candidates) {
      const secs = `${(c.durationMs / 1000).toFixed(1)}s`;
      const tokensNote =
        c.tokensUsed && c.tokensUsed > 0 ? ` · ${c.tokensUsed.toLocaleString('en-US')} tokens` : '';
      const recBadge =
        recommendedIndex === c.index ? ` ${colors.green}${colors.bold}★ recommended${colors.reset}` : '';
      const statusBadge =
        c.success && c.filesChanged.length > 0
          ? `${colors.green}✔${colors.reset}`
          : c.success
            ? `${colors.yellow}○ no changes${colors.reset}`
            : `${colors.red}✖${colors.reset}`;
      const checkBadge =
        c.checkPassed === true
          ? `  ${colors.green}✔ checks passed${colors.reset}`
          : c.checkPassed === false
            ? `  ${colors.red}✖ checks failed${colors.reset}${c.checkSummary ? ` (${c.checkSummary.slice(0, 80)})` : ''}`
            : '';
      const lines = [
        `  ${colors.bold}#${c.index}${colors.reset} ${statusBadge} ${colors.brand}${colors.bold}${c.agentName}${colors.reset} ${colors.dim}(${c.agentId} · ${secs}${tokensNote})${colors.reset}${recBadge}${checkBadge}`,
      ];
      if (c.error) {
        lines.push(`     ${colors.red}${c.error}${colors.reset}`);
      } else {
        if (c.diffStat) {
          lines.push(
            ...c.diffStat
              .split('\n')
              .slice(0, 6)
              .map((l) => `     ${colors.dim}${l}${colors.reset}`),
          );
        } else {
          lines.push(`     ${colors.dim}(no file changes produced)${colors.reset}`);
        }
        if (c.response) {
          const snippet = c.response.split('\n').slice(0, 3).join(' ').slice(0, 220);
          lines.push(`     ${snippet}`);
        }
      }
      sections.push(lines.join('\n'));
    }

    const hasAnyApplicable = candidates.some((c) => c.success && c.filesChanged.length > 0 && c.commitHash);
    if (!hasAnyApplicable) {
      await this.discardCompetitiveEdit(pending);
      sections.push(
        `  ${colors.dim}No candidate produced applicable changes; temporary worktrees were cleaned up.${colors.reset}`,
      );
      return { formatted: sections.join('\n\n') };
    }

    const hint = recommendedIndex
      ? `↵ Enter: apply #${recommendedIndex} (${candidates[recommendedIndex - 1].agentName})   ·   type 1..${candidates.length} to pick   ·   diff <n>   ·   mix fileA:#1 fileB:#2   ·   /back to discard`
      : `type 1..${candidates.length} to apply   ·   diff <n>   ·   mix fileA:#1 fileB:#2   ·   /back to discard`;
    sections.push(`  ${colors.dim}${hint}${colors.reset}`);

    return {
      formatted: sections.join('\n\n'),
      pending,
    };
  }

  public async getCompetitiveCandidateDiff(
    pending: PendingCompetitiveEdit,
    indexOneBased: number,
  ): Promise<string> {
    const candidate = pending.candidates.find((c) => c.index === indexOneBased);
    if (!candidate) {
      return `${colors.red}✖ Candidate #${indexOneBased} not found.${colors.reset} Choose 1..${pending.candidates.length}.`;
    }
    if (!candidate.commitHash || candidate.commitHash === candidate.baseCommit) {
      return `${colors.dim}Candidate #${candidate.index} (${candidate.agentName}) made no file changes.${colors.reset}`;
    }
    const git = this.gitService ?? new GitService(this.repoRoot);
    const diff = await git
      .exec(['diff', `${candidate.baseCommit}..${candidate.commitHash}`], candidate.worktreePath)
      .catch(() => '');
    const lines = diff.split('\n');
    const preview =
      lines.length > 120
        ? [...lines.slice(0, 120), `... (${lines.length - 120} more diff lines omitted)`].join('\n')
        : diff;
    return [
      `${colors.brand}✦ ${colors.bold}Diff #${candidate.index} — ${candidate.agentName}${colors.reset} ${colors.dim}(${candidate.filesChanged.join(', ')})${colors.reset}`,
      preview || `${colors.dim}(empty diff)${colors.reset}`,
      '',
      `  ${colors.dim}Type ${candidate.index} to apply this candidate, Enter for recommended, or /back to discard.${colors.reset}`,
    ].join('\n');
  }

  public async applyCompetitiveCandidate(
    pending: PendingCompetitiveEdit,
    indexOneBased: number,
  ): Promise<string> {
    const candidate = pending.candidates.find((c) => c.index === indexOneBased);
    if (!candidate) {
      return `${colors.red}✖ Candidate #${indexOneBased} not found.${colors.reset} Choose 1..${pending.candidates.length}.`;
    }
    if (!candidate.commitHash || candidate.filesChanged.length === 0) {
      return `${colors.yellow}⚠ Candidate #${candidate.index} (${candidate.agentName}) has no changes to apply.${colors.reset}`;
    }

    const git = this.gitService ?? new GitService(this.repoRoot);
    const checkpoint = this.checkpointManager
      ? await this.checkpointManager.capture(`competitive apply: ${pending.prompt}`, candidate.agentId)
      : undefined;
    try {
      await git.exec(['cherry-pick', '--no-commit', candidate.commitHash], this.repoRoot);
      if (checkpoint) {
        this.checkpointManager?.annotateFilesTouched(checkpoint.id, candidate.filesChanged);
      }
    } catch (err) {
      if (checkpoint) {
        await this.checkpointManager?.discard(checkpoint.id);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `${colors.red}✖ Could not apply candidate #${candidate.index} (${candidate.agentName}) cleanly:${colors.reset} ${msg}\n  ${colors.dim}Temporary worktrees are kept; resolve conflicts or /back to discard.${colors.reset}`;
    }

    await this.discardCompetitiveEdit(pending);
    this.memory.record({
      kind: 'agent',
      agentId: candidate.agentId,
      agentName: candidate.agentName,
      response: candidate.response || `Applied competitive edit #${candidate.index}`,
      durationMs: candidate.durationMs,
      filesChanged: candidate.filesChanged,
      timestamp: new Date().toISOString(),
    });
    this.onStateChanged?.();

    return [
      `${colors.green}✔${colors.reset} Applied candidate ${colors.bold}#${candidate.index} (${candidate.agentName})${colors.reset} to your working tree (staged, not committed).`,
      `  ${colors.cyan}Files:${colors.reset} ${candidate.filesChanged.join(', ')}`,
      `  ${colors.dim}Temporary competitive worktrees cleaned up. Run !git diff --cached to review.${colors.reset}`,
    ].join('\n');
  }

  /**
   * Hybrid per-file cherry-pick across competing candidates (`mix src/a.ts:#1 src/b.ts:#2`),
   * allowing the user to combine the best files from different agents with an automatic
   * pre-apply checkpoint for `/undo`.
   */
  public async applyCompetitiveFiles(
    pending: PendingCompetitiveEdit,
    picks: Array<{ file: string; candidateIndex: number }>,
  ): Promise<string> {
    if (picks.length === 0) {
      return `${colors.red}✖ Specify at least one file pick (e.g. mix src/a.ts:#1 src/b.ts:#2).${colors.reset}`;
    }
    const git = this.gitService ?? new GitService(this.repoRoot);
    const checkpoint = this.checkpointManager
      ? await this.checkpointManager.capture(`hybrid competitive mix: ${pending.prompt}`, 'mix')
      : undefined;

    const appliedSummary: string[] = [];
    const touchedFiles: string[] = [];
    try {
      for (const pick of picks) {
        const cand = pending.candidates.find((c) => c.index === pick.candidateIndex);
        if (!cand || !cand.commitHash) {
          throw new Error(`Candidate #${pick.candidateIndex} has no commit for "${pick.file}".`);
        }
        await git.exec(['checkout', cand.commitHash, '--', pick.file], this.repoRoot);
        appliedSummary.push(`${pick.file} ← #${cand.index} (${cand.agentName})`);
        touchedFiles.push(pick.file);
      }
      if (checkpoint) {
        this.checkpointManager?.annotateFilesTouched(checkpoint.id, touchedFiles);
      }
    } catch (err) {
      if (checkpoint) {
        await this.checkpointManager?.discard(checkpoint.id);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `${colors.red}✖ Could not apply hybrid file picks:${colors.reset} ${msg}`;
    }

    await this.discardCompetitiveEdit(pending);
    this.memory.record({
      kind: 'agent',
      agentId: 'mix',
      agentName: 'Hybrid Competitive Mix',
      response: `Applied hybrid file selection:\n${appliedSummary.map((s) => `- ${s}`).join('\n')}`,
      durationMs: 0,
      filesChanged: touchedFiles,
      timestamp: new Date().toISOString(),
    });
    this.onStateChanged?.();

    return [
      `${colors.green}✔${colors.reset} Applied hybrid file selection to your working tree:`,
      ...appliedSummary.map((s) => `  • ${colors.cyan}${s}${colors.reset}`),
      `  ${colors.dim}Temporary competitive worktrees cleaned up.${checkpoint ? ` Checkpoint ${checkpoint.id} saved (/undo to revert).` : ''}${colors.reset}`,
    ].join('\n');
  }

  public async discardCompetitiveEdit(pending: PendingCompetitiveEdit): Promise<void> {
    const wtManager = this.worktreeManager ?? new WorktreeManager(this.repoRoot);
    for (const c of pending.candidates) {
      await wtManager.removeWorktree(c.taskId, c.assignmentId, true, true).catch(() => {});
    }
  }

  /**
   * Executes an expressive Direct Handoff Pipeline (`@codex -> @agy <task>` or
   * multi-stage `@codex -> @agy -> @claude <task>`):
   * - Stage 1 executes the task directly (with auto-checkpoint if mutating).
   * - Subsequent stages receive Stage 1's summary + exact working-tree diff
   *   and perform an independent read-only review/refinement.
   * - If Stage 1 mutated files and the final reviewer surfaced actionable issues,
   *   returns a `PendingPipelineFollowUp` for 1-Enter fix application.
   */
  public async runPipeline(
    stages: string[],
    rawPrompt: string,
    options: { priorContext?: string; abortSignal?: AbortSignal } = {},
  ): Promise<{
    formatted: string;
    outcomes: DirectAgentTurnOutcome[];
    pendingFollowUp?: PendingPipelineFollowUp;
  }> {
    const resolvedMentions = resolveFileMentionsInPrompt(rawPrompt, this.repoRoot);
    const prompt = resolvedMentions.cleanedPrompt;

    // Resolve each stage (expanding `smart` via problem-size router).
    const resolvedAdapters: AgentAdapter[] = [];
    const unavailable: string[] = [];
    for (const stage of stages) {
      if (stage === 'smart') {
        const { adapters } = await this.resolveTargets('smart', prompt, resolvedMentions.files);
        if (adapters[0]) {
          resolvedAdapters.push(adapters[0]);
        } else {
          unavailable.push('smart (no ready agent)');
        }
      } else {
        const { adapters, unavailable: unavail } = await this.resolveTargets([stage], prompt, resolvedMentions.files);
        if (adapters[0]) {
          resolvedAdapters.push(adapters[0]);
        } else {
          unavailable.push(...unavail);
        }
      }
    }

    if (resolvedAdapters.length < 2) {
      const detail =
        unavailable.length > 0
          ? `Unavailable: ${unavailable.join(', ')}.`
          : 'At least 2 ready agents are required for a handoff pipeline.';
      return {
        formatted: `${colors.red}✖ Cannot run direct handoff pipeline.${colors.reset} ${detail}`,
        outcomes: [],
      };
    }

    const intent = detectExecutionIntent(prompt);
    const stage1Mutation = intent.mutationAllowed;
    const chainLabel = resolvedAdapters.map((a) => `${colors.bold}${a.name}${colors.reset}`).join(' → ');
    this.onLiveLine?.(
      `\n  ${colors.brand}✦${colors.reset} Direct Pipeline: ${chainLabel} ${colors.dim}(${stage1Mutation ? 'implement → review' : 'analyze → refine'})${colors.reset}\n`,
    );

    const outcomes: DirectAgentTurnOutcome[] = [];
    const stageSections: string[] = [];
    const git = this.gitService ?? new GitService(this.repoRoot);

    let stage1FilesChanged: string[] = [];
    let stage1DiffSnippet = '';
    let stage1CheckpointId: string | undefined;

    for (let i = 0; i < resolvedAdapters.length; i++) {
      const adapter = resolvedAdapters[i];
      const isFirst = i === 0;
      const allowWrite = isFirst && stage1Mutation;
      const stageTag = isFirst
        ? allowWrite
          ? 'Stage 1 · Implement'
          : 'Stage 1 · Lead'
        : `Stage ${i + 1} · ${stage1Mutation ? 'Independent Review' : 'Critique & Refine'}`;

      const preCheckpoint =
        allowWrite && this.checkpointManager
          ? await this.checkpointManager.capture(`pipeline: ${prompt}`, adapter.id)
          : undefined;
      const beforeDirty = allowWrite ? await snapshotDirtyFiles(this.repoRoot, git) : new Set<string>();

      let stagePrompt = prompt;
      if (!isFirst) {
        const prev = outcomes[outcomes.length - 1];
        const parts = [
          `Original user request:\n${prompt}`,
          `\nPrevious stage (${prev.agentName} · ${prev.agentId}) output:\n${prev.response.slice(0, 4000)}`,
        ];
        if (stage1FilesChanged.length > 0) {
          parts.push(`\nModified files: ${stage1FilesChanged.join(', ')}`);
        }
        if (stage1DiffSnippet) {
          parts.push(`\nExact git diff produced:\n\`\`\`diff\n${stage1DiffSnippet}\n\`\`\``);
        }
        parts.push(
          stage1Mutation
            ? '\nYour role: Independent reviewer (read-only). Audit the changes carefully for bugs, edge cases, regressions, missing tests, or cleaner approaches. If everything looks solid with no fixes needed, start with "LGTM:" and summarize why. Otherwise list concrete, actionable fixes.'
            : '\nYour role: Independent second-opinion reviewer (read-only). Critique the previous stage output, catch any blind spots or inaccuracies, and provide a sharper refined answer.',
        );
        stagePrompt = parts.join('\n');
      }

      if (isFirst) {
        this.memory.record({
          kind: 'user',
          text: `[pipeline ${resolvedAdapters.map((a) => a.id).join(' -> ')}] ${prompt}`,
          timestamp: new Date().toISOString(),
        });
      }

      this.onLiveLine?.(
        `\n  ${colors.cyan}▸ ${stageTag}:${colors.reset} ${colors.bold}${adapter.name}${colors.reset}\n`,
      );

      const start = Date.now();
      const assignment: AgentAssignment = {
        id: `pipe-${i + 1}-${adapter.id}-${randomUUID().slice(0, 8)}`,
        taskId: `PIPE-${i + 1}`,
        agentId: adapter.id,
        role: allowWrite ? 'implementer' : 'reviewer',
        objective: stagePrompt,
        status: 'running',
      };
      const lastSeen = { line: '', streamed: '' };
      let startedTextStream = false;
      const context: AgentContext = {
        worktreePath: this.repoRoot,
        originalUserRequest: prompt,
        priorContext: options.priorContext,
        conversationHistory: isFirst ? this.memory.formatForPrompt() || undefined : undefined,
        directMode: true,
        mutationAllowed: allowWrite,
        timeoutMs: this.timeoutMs,
        abortSignal: options.abortSignal,
        assignment,
        task: {
          objective: stagePrompt,
          allowedScope: allowWrite ? ['**'] : [],
          forbiddenChanges: allowWrite ? [] : ['*'],
          acceptanceCriteria: [
            allowWrite
              ? 'Complete the requested change cleanly'
              : 'Provide an accurate, concrete independent review',
          ],
          dependencies: [],
        },
        onStreamEvent: (ev) => {
          if (ev.type === 'agent_message' && this.onLiveLine && ev.text) {
            const incoming = ev.text;
            if (
              lastSeen.streamed.trim().length > 0 &&
              (incoming.trim() === lastSeen.streamed.trim() || lastSeen.streamed.endsWith(incoming))
            ) {
              return;
            }
            if (!startedTextStream) {
              startedTextStream = true;
              this.onLiveLine('\n');
            }
            const chunk =
              incoming.startsWith(lastSeen.streamed) && lastSeen.streamed.length > 0
                ? incoming.slice(lastSeen.streamed.length)
                : incoming;
            if (chunk) {
              lastSeen.streamed += chunk;
              this.onLiveLine(chunk);
            }
            return;
          }
          const line = formatStreamLine(adapter.name, ev);
          if (line && line !== lastSeen.line) {
            lastSeen.line = line;
            if (startedTextStream) {
              this.onLiveLine?.('\n');
              startedTextStream = false;
            }
            this.onLiveLine?.(`${line}\n`);
          }
        },
      };

      let outcome: DirectAgentTurnOutcome;
      try {
        const res = await adapter.execute(assignment, context);
        if (startedTextStream && !lastSeen.streamed.endsWith('\n')) {
          this.onLiveLine?.('\n');
        }
        outcome = {
          agentId: adapter.id,
          agentName: adapter.name,
          success: res.success,
          response: (res.output || res.message || '').trim() || (res.success ? '(completed)' : 'Execution failed'),
          durationMs: res.durationMs || Date.now() - start,
          tokensUsed: res.usage?.totalTokens,
          filesChanged: [],
          error: res.success ? undefined : res.message || 'Execution failed',
        };
      } catch (err) {
        outcome = {
          agentId: adapter.id,
          agentName: adapter.name,
          success: false,
          response: '',
          durationMs: Date.now() - start,
          filesChanged: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (allowWrite) {
        const afterDirty = await snapshotDirtyFiles(this.repoRoot, git);
        let changed = [...afterDirty].filter((f) => !beforeDirty.has(f));
        if (changed.length === 0 && preCheckpoint) {
          const rawNames = await git
            .exec(['diff', '--name-only', preCheckpoint.treeHash], this.repoRoot)
            .catch(() => '');
          changed = rawNames.split('\n').map((l) => l.trim()).filter(Boolean);
        }
        outcome.filesChanged = changed;
        stage1FilesChanged = changed;
        if (preCheckpoint) {
          if (changed.length > 0) {
            this.checkpointManager?.annotateFilesTouched(preCheckpoint.id, changed);
            stage1CheckpointId = preCheckpoint.id;
          } else {
            await this.checkpointManager?.discard(preCheckpoint.id);
          }
        }
        if (changed.length > 0) {
          const baseRef = preCheckpoint?.treeHash ?? 'HEAD';
          const diffRaw = await git.exec(['diff', baseRef], this.repoRoot).catch(() => '');
          stage1DiffSnippet = diffRaw.slice(0, 9000);
        }
      }

      outcomes.push(outcome);
      if (outcome.response) {
        this.memory.record({
          kind: 'agent',
          agentId: outcome.agentId,
          agentName: `${outcome.agentName} (${stageTag})`,
          response: outcome.response,
          durationMs: outcome.durationMs,
          filesChanged: outcome.filesChanged,
          timestamp: new Date().toISOString(),
        });
      }

      const secs = `${(outcome.durationMs / 1000).toFixed(1)}s`;
      const badge = outcome.success ? `${colors.green}✔${colors.reset}` : `${colors.red}✖${colors.reset}`;
      const alreadyStreamed =
        outcome.success &&
        lastSeen.streamed.trim() === outcome.response.trim() &&
        outcome.response.trim().length > 0;
      const body = outcome.success
        ? alreadyStreamed
          ? ''
          : outcome.response
        : `${colors.red}${outcome.error || outcome.response}${colors.reset}`;
      const filesNote =
        outcome.filesChanged.length > 0
          ? `\n  ${colors.cyan}Modified files:${colors.reset} ${outcome.filesChanged.join(', ')}${stage1CheckpointId ? ` ${colors.dim}(checkpoint ${stage1CheckpointId})${colors.reset}` : ''}`
          : '';
      stageSections.push(
        `${badge} ${colors.brand}${colors.bold}${stageTag} — ${outcome.agentName}${colors.reset} ${colors.dim}(${outcome.agentId} · ${secs})${colors.reset}${body ? `\n${body}` : ''}${filesNote}`,
      );

      // Stop pipeline early if a stage failed.
      if (!outcome.success) break;
    }

    this.onStateChanged?.();

    let pendingFollowUp: PendingPipelineFollowUp | undefined;
    const first = outcomes[0];
    const last = outcomes[outcomes.length - 1];
    if (
      stage1Mutation &&
      outcomes.length >= 2 &&
      first?.success &&
      last?.success &&
      stage1FilesChanged.length > 0 &&
      !looksLikeCleanApproval(last.response)
    ) {
      pendingFollowUp = {
        implementerId: first.agentId,
        implementerName: first.agentName,
        reviewerId: last.agentId,
        reviewerName: last.agentName,
        originalPrompt: prompt,
        findings: last.response,
        filesChanged: stage1FilesChanged,
      };
      stageSections.push(
        `  ${colors.dim}↵ Enter: apply reviewer fixes (via ${last.agentName})   ·   type "${first.agentId}" to send fixes back to ${first.agentName}   ·   /undo to revert   ·   /back to keep as-is${colors.reset}`,
      );
    }

    return {
      formatted: stageSections.join(`\n\n${colors.darkGray}${'─'.repeat(60)}${colors.reset}\n\n`),
      outcomes,
      pendingFollowUp,
    };
  }

  /** Applies the findings from a Direct Handoff Pipeline review in 1 Enter. */
  public async applyPipelineFollowUp(
    pending: PendingPipelineFollowUp,
    targetAgentId: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const fixPrompt = [
      `Apply the review improvements below to the workspace changes made for: "${pending.originalPrompt}"`,
      `Files previously modified: ${pending.filesChanged.join(', ')}`,
      `\nReview findings from ${pending.reviewerName}:\n${pending.findings.slice(0, 4500)}`,
      '\nApply only the concrete fixes needed, keeping changes minimal and clean.',
    ].join('\n');
    const res = await this.runAgents([targetAgentId], fixPrompt, {
      abortSignal,
      autoReason: `applying review fixes from ${pending.reviewerName}`,
    });
    return res.formatted;
  }

  /**
   * Executes a 2-round structured Direct Debate (`@codex <-> @agy <question>`):
   * - Round 1: all target agents answer independently in parallel (read-only).
   * - Round 2: each agent reads the peers' Round 1 answers and delivers a
   *   focused cross-critique + refined position in parallel (read-only).
   * - Synthesis: produces a concise `✦ Debate Verdict`.
   */
  public async runDebate(
    targets: 'all' | string[],
    rawPrompt: string,
    options: { priorContext?: string; abortSignal?: AbortSignal } = {},
  ): Promise<{ formatted: string; round1: DirectAgentTurnOutcome[]; round2: DirectAgentTurnOutcome[] }> {
    const resolvedMentions = resolveFileMentionsInPrompt(rawPrompt, this.repoRoot);
    const prompt = resolvedMentions.cleanedPrompt;
    const { adapters, unavailable } = await this.resolveTargets(targets, prompt, resolvedMentions.files);

    if (adapters.length < 2) {
      const detail =
        unavailable.length > 0
          ? `Unavailable: ${unavailable.join(', ')}.`
          : 'At least 2 ready agents are required for a structured debate (<->).';
      return {
        formatted: `${colors.red}✖ Cannot run direct debate.${colors.reset} ${detail}`,
        round1: [],
        round2: [],
      };
    }

    this.memory.record({
      kind: 'user',
      text: `[debate ${adapters.map((a) => a.id).join(' <-> ')}] ${prompt}`,
      timestamp: new Date().toISOString(),
    });

    const headerNames = adapters.map((a) => `${colors.bold}${a.name}${colors.reset}`).join(' ↔ ');
    this.onLiveLine?.(
      `\n  ${colors.brand}✦${colors.reset} Structured Direct Debate: ${headerNames} ${colors.dim}(2 rounds · read-only)${colors.reset}\n`,
    );

    const historySnapshot = this.memory.formatForPrompt();
    const runReadOnly = async (
      adapter: AgentAdapter,
      roundNum: number,
      turnPrompt: string,
    ): Promise<DirectAgentTurnOutcome> => {
      const start = Date.now();
      const assignment: AgentAssignment = {
        id: `debate-r${roundNum}-${adapter.id}-${randomUUID().slice(0, 8)}`,
        taskId: `DEBATE-R${roundNum}`,
        agentId: adapter.id,
        role: 'researcher',
        objective: turnPrompt,
        status: 'running',
      };
      const lastSeen = { line: '' };
      const context: AgentContext = {
        worktreePath: this.repoRoot,
        originalUserRequest: prompt,
        priorContext: options.priorContext,
        conversationHistory: roundNum === 1 ? historySnapshot || undefined : undefined,
        directMode: true,
        mutationAllowed: false,
        timeoutMs: this.timeoutMs,
        abortSignal: options.abortSignal,
        assignment,
        task: {
          objective: turnPrompt,
          allowedScope: [],
          forbiddenChanges: ['*'],
          acceptanceCriteria: ['Provide a clear, evidence-backed engineering position'],
          dependencies: [],
        },
        onStreamEvent: (ev) => {
          const line = formatStreamLine(`${adapter.name}·R${roundNum}`, ev);
          if (line && line !== lastSeen.line) {
            lastSeen.line = line;
            this.onLiveLine?.(`${line}\n`);
          }
        },
      };
      try {
        const res = await adapter.execute(assignment, context);
        return {
          agentId: adapter.id,
          agentName: adapter.name,
          success: res.success,
          response: (res.output || res.message || '').trim() || (res.success ? '(no output)' : 'Failed'),
          durationMs: res.durationMs || Date.now() - start,
          tokensUsed: res.usage?.totalTokens,
          filesChanged: [],
          error: res.success ? undefined : res.message || 'Execution failed',
        };
      } catch (err) {
        return {
          agentId: adapter.id,
          agentName: adapter.name,
          success: false,
          response: '',
          durationMs: Date.now() - start,
          filesChanged: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    // Round 1 — Independent positions in parallel
    this.onLiveLine?.(`  ${colors.cyan}▸ Round 1:${colors.reset} Independent positions...\n`);
    const round1 = await Promise.all(adapters.map((a) => runReadOnly(a, 1, prompt)));
    const okR1 = round1.filter((o) => o.success && o.response.trim().length > 0);

    // Round 2 — Cross-critique in parallel (only if >= 2 agents succeeded in Round 1)
    let round2: DirectAgentTurnOutcome[] = [];
    if (okR1.length >= 2) {
      this.onLiveLine?.(`  ${colors.cyan}▸ Round 2:${colors.reset} Cross-critique & refinement...\n`);
      round2 = await Promise.all(
        adapters.map((adapter) => {
          const own = okR1.find((o) => o.agentId === adapter.id);
          const peers = okR1.filter((o) => o.agentId !== adapter.id);
          const critiquePrompt = [
            `Original question:\n${prompt}`,
            own ? `\nYour Round 1 position:\n${own.response.slice(0, 2200)}` : '',
            ...peers.map(
              (p) => `\nPeer position — ${p.agentName} (${p.agentId}):\n${p.response.slice(0, 2200)}`,
            ),
            '\nRound 2 instructions (concise, read-only):',
            '1. Identify concrete blind spots, trade-offs, or flaws in the peer position(s).',
            '2. Note what you agree with or would adopt from the peer(s).',
            '3. Give your refined final recommendation.',
          ]
            .filter(Boolean)
            .join('\n');
          return runReadOnly(adapter, 2, critiquePrompt);
        }),
      );
    }

    const okR2 = round2.filter((o) => o.success && o.response.trim().length > 0);
    const synthesisOutcomes = okR2.length >= 2 ? okR2 : okR1;
    const verdict =
      synthesisOutcomes.length >= 2
        ? await this.synthesizeConsensus(
            `Debate verdict for: ${prompt}`,
            synthesisOutcomes,
          )
        : undefined;

    for (const o of synthesisOutcomes) {
      this.memory.record({
        kind: 'agent',
        agentId: o.agentId,
        agentName: `${o.agentName} (Debate)`,
        response: o.response,
        durationMs: o.durationMs,
        filesChanged: [],
        timestamp: new Date().toISOString(),
      });
    }
    this.onStateChanged?.();

    const sections: string[] = [];
    if (unavailable.length > 0) {
      sections.push(`  ${colors.yellow}⚠ Skipped unavailable:${colors.reset} ${unavailable.join(', ')}`);
    }

    const renderRound = (title: string, items: DirectAgentTurnOutcome[]) => {
      const lines = [`${colors.brand}✦ ${colors.bold}${title}${colors.reset}`];
      for (const o of items) {
        const secs = `${(o.durationMs / 1000).toFixed(1)}s`;
        const badge = o.success ? `${colors.green}✔${colors.reset}` : `${colors.red}✖${colors.reset}`;
        lines.push(
          `\n${badge} ${colors.bold}${o.agentName}${colors.reset} ${colors.dim}(${o.agentId} · ${secs})${colors.reset}`,
        );
        lines.push(o.success ? o.response : `${colors.red}${o.error || o.response}${colors.reset}`);
      }
      return lines.join('\n');
    };

    sections.push(renderRound('Round 1 — Independent Positions', round1));
    if (round2.length > 0) {
      sections.push(renderRound('Round 2 — Cross-Critique & Refinement', round2));
    }
    if (verdict) {
      sections.push(`${colors.brand}✦ ${colors.bold}Debate Verdict${colors.reset}\n${verdict}`);
    }

    return {
      formatted: sections.join(`\n\n${colors.darkGray}${'─'.repeat(60)}${colors.reset}\n\n`),
      round1,
      round2,
    };
  }

  /**
   * Adversarial Multi-Agent TDD Loop (`/tdd [@tester -> @implementer] <spec>`):
   * - Phase 1 (Red): `tester` writes focused failing tests encoding `<spec>`.
   * - Phase 2 (Green): `implementer` implements production code to make those
   *   tests pass (with bounded fix iterations), verifying via `testCommand`.
   */
  public async runAdversarialTdd(
    testerTarget: string | 'smart',
    implementerTarget: string | 'smart',
    rawSpec: string,
    options: { testCommand?: string; abortSignal?: AbortSignal; maxGreenAttempts?: number } = {},
  ): Promise<{ formatted: string; passed: boolean; filesChanged: string[] }> {
    const resolved = resolveFileMentionsInPrompt(rawSpec, this.repoRoot);
    const spec = resolved.cleanedPrompt;
    const reports = await AgentDetector.detect(this.agentRegistry.list());
    const ready = reports
      .filter((r) => r.ready)
      .map((r) => this.agentRegistry.get(r.id))
      .filter((a): a is AgentAdapter => Boolean(a));

    const tester =
      testerTarget === 'smart'
        ? ready[0]
        : ready.find((a) => a.id === testerTarget);
    const implementer =
      implementerTarget === 'smart'
        ? (ready.find((a) => a.id !== tester?.id) ?? ready[0])
        : ready.find((a) => a.id === implementerTarget);

    if (!tester || !implementer) {
      return {
        formatted: `${colors.red}✖ Cannot run /tdd.${colors.reset} No ready agents detected (check /agents).`,
        passed: false,
        filesChanged: [],
      };
    }

    const testCmd = options.testCommand ?? this.verificationCommands[0];
    this.onLiveLine?.(
      `\n  ${colors.brand}✦ ${colors.bold}Adversarial Multi-Agent TDD${colors.reset} ${colors.dim}(Red: ${tester.name} → Green: ${implementer.name}${testCmd ? ` · check: ${testCmd}` : ''})${colors.reset}\n`,
    );

    // Phase 1 — Red: Test Author writes failing tests
    const redPrompt = [
      `[TDD Phase 1 — RED (Test Author)]`,
      `Write focused, clean automated tests that specify and assert the behavior below. Do NOT implement the production feature yet — only write tests so they fail until implemented.`,
      `\nSpecification:\n${spec}`,
    ].join('\n');
    const redRes = await this.runAgents([tester.id], redPrompt, {
      abortSignal: options.abortSignal,
      autoReason: 'TDD Phase 1 (Red — write failing tests)',
    });
    const redFiles = redRes.outcomes[0]?.filesChanged ?? [];

    const runTestCmd = async (): Promise<{ passed: boolean; output: string }> => {
      if (!testCmd) return { passed: true, output: '(no test command configured)' };
      const r = await ProcessRunner.run({
        command: process.env.SHELL || '/bin/sh',
        args: ['-lc', testCmd],
        cwd: this.repoRoot,
        timeoutMs: Math.min(this.timeoutMs, 120_000),
        abortSignal: options.abortSignal,
      });
      const combined = [r.stdout, r.stderr].filter((s) => s.trim()).join('\n').trim();
      return { passed: r.exitCode === 0, output: combined.slice(-2500) };
    };

    const redCheck = await runTestCmd();

    // Phase 2 — Green: Implementer makes tests pass (bounded attempts)
    const maxAttempts = Math.max(1, options.maxGreenAttempts ?? 2);
    let lastCheck = redCheck;
    let greenOutcomeSummary = '';
    const allChanged = new Set<string>(redFiles);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const greenPrompt = [
        `[TDD Phase 2 — GREEN (Implementer · Attempt ${attempt}/${maxAttempts})]`,
        `Implement the clean production code required to satisfy the specification and make the test suite pass. Do NOT weaken or delete the test assertions written in Phase 1.`,
        `\nSpecification:\n${spec}`,
        redFiles.length > 0 ? `\nTest files written in Phase 1: ${redFiles.join(', ')}` : '',
        !lastCheck.passed && lastCheck.output
          ? `\nLatest test output to fix:\n\`\`\`\n${lastCheck.output}\n\`\`\``
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const greenRes = await this.runAgents([implementer.id], greenPrompt, {
        abortSignal: options.abortSignal,
        autoReason: `TDD Phase 2 (Green — attempt ${attempt}/${maxAttempts})`,
      });
      for (const f of greenRes.outcomes[0]?.filesChanged ?? []) allChanged.add(f);
      greenOutcomeSummary = greenRes.outcomes[0]?.response ?? '';

      lastCheck = await runTestCmd();
      if (lastCheck.passed) break;
    }

    const statusBadge = lastCheck.passed
      ? `${colors.green}✔ GREEN — tests passing${colors.reset}`
      : `${colors.red}✖ RED — tests still failing after ${maxAttempts} attempt(s)${colors.reset}`;

    return {
      passed: lastCheck.passed,
      filesChanged: [...allChanged],
      formatted: [
        `${colors.brand}✦ ${colors.bold}Adversarial TDD Summary${colors.reset}  ${statusBadge}`,
        `  ${colors.cyan}Red (${tester.name}):${colors.reset} ${redFiles.length > 0 ? redFiles.join(', ') : '(see test output)'} ${testCmd ? `· pre-impl check: ${redCheck.passed ? 'passed' : 'failed (expected Red)'}` : ''}`,
        `  ${colors.green}Green (${implementer.name}):${colors.reset} ${greenOutcomeSummary.slice(0, 260) || '(completed)'}`,
        allChanged.size > 0 ? `  ${colors.cyan}Files touched:${colors.reset} ${[...allChanged].join(', ')}` : '',
        !lastCheck.passed && lastCheck.output
          ? `\n  ${colors.red}Last test output:${colors.reset}\n${lastCheck.output.slice(-900)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}

function looksLikeCleanApproval(reviewText: string): boolean {
  const trimmed = reviewText.trim();
  if (!trimmed) return true;
  const firstLine = trimmed.split('\n')[0] ?? '';
  if (/^\s*(?:\*\*?)?(?:lgtm|looks\s+good(?:\s+to\s+me)?|no\s+issues\s+found|approved|sem\s+problemas|tudo\s+certo)\b/i.test(firstLine)) {
    return !/\b(?:bug|fix|issue|error|problem|corrig|ajust|falha|risco)\b/i.test(trimmed.slice(firstLine.length));
  }
  return false;
}

function buildDeterministicConsensusFallback(outcomes: DirectAgentTurnOutcome[]): string {
  const filePathRe = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|swift|md|json|yaml|yml|toml|sql)\b/g;
  const filesByAgent = outcomes.map((o) => ({
    agentName: o.agentName,
    agentId: o.agentId,
    files: new Set((o.response.match(filePathRe) ?? []).map((f) => f.replace(/^\.\//, ''))),
    firstPoint: o.response
      .split('\n')
      .map((l) => l.trim().replace(/^[-*•\d.)\s]+/, ''))
      .find((l) => l.length > 15)
      ?.slice(0, 140),
  }));

  const allFileCounts = new Map<string, number>();
  for (const item of filesByAgent) {
    for (const f of item.files) {
      allFileCounts.set(f, (allFileCounts.get(f) ?? 0) + 1);
    }
  }
  const sharedFiles = [...allFileCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([file]) => file)
    .slice(0, 6);

  const lines: string[] = [];
  if (sharedFiles.length > 0) {
    lines.push(`  • Shared focus files (${outcomes.length} agents): ${sharedFiles.join(', ')}`);
  }
  for (const item of filesByAgent) {
    const uniqueFiles = [...item.files].filter((f) => (allFileCounts.get(f) ?? 0) === 1).slice(0, 4);
    const uniqueNote = uniqueFiles.length > 0 ? ` (unique files: ${uniqueFiles.join(', ')})` : '';
    const lead = item.firstPoint ? ` — ${item.firstPoint}` : '';
    lines.push(`  • ${item.agentName}${lead}${uniqueNote}`);
  }
  return lines.join('\n');
}
