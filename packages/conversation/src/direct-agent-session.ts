import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentRegistry } from '@taskforge/agents';
import { AgentDetector } from '@taskforge/agents';
import { ProcessRunner } from '@taskforge/execution';
import {
  type AgentAssignment,
  type AgentContext,
  type AgentStreamEvent,
  detectExecutionIntent,
} from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';
import { colors } from './theme.js';
import { assessProblemAndSelectAgent } from './problem-size-router.js';

export type DirectSessionEntry =
  | { kind: 'user'; text: string; timestamp: string }
  | {
      kind: 'agent';
      agentId: string;
      agentName: string;
      response: string;
      durationMs: number;
      filesChanged?: string[];
      timestamp: string;
    }
  | {
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

  constructor(maxEntries = 24) {
    this.maxEntries = maxEntries;
  }

  public record(entry: DirectSessionEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  public getEntries(): readonly DirectSessionEntry[] {
    return this.entries;
  }

  public clear(): void {
    this.entries = [];
  }

  public formatForPrompt(maxChars = 8000): string {
    if (this.entries.length === 0) return '';
    const blocks: string[] = [];
    let used = 0;

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
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
}

export interface DirectRunnerOptions {
  repoRoot: string;
  agentRegistry: AgentRegistry;
  memory: DirectConversationMemory;
  timeoutMs?: number;
  onLiveLine?: (line: string) => void;
  gitService?: GitService;
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

  constructor(options: DirectRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.agentRegistry = options.agentRegistry;
    this.memory = options.memory;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.onLiveLine = options.onLiveLine;
    this.gitService = options.gitService;
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
      const rec = assessProblemAndSelectAgent({
        text: prompt,
        availableAgents: ready.map((a) => a.id),
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
        selectionReason: rec.reason,
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
    prompt: string,
    options: { priorContext?: string; abortSignal?: AbortSignal } = {},
  ): Promise<{ formatted: string; outcomes: DirectAgentTurnOutcome[] }> {
    const { adapters, unavailable, selectionReason } = await this.resolveTargets(targets, prompt);
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
    const beforeDirty = mutationAllowed ? await snapshotDirtyFiles(this.repoRoot, this.gitService) : new Set<string>();

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
    this.onLiveLine?.(
      `\n  ${colors.brand}✦${colors.reset} ${headerTargets} ${colors.dim}(${modeLabel}${selectionReason ? ` · auto: ${selectionReason}` : ''})${colors.reset}\n`,
    );

    const runOne = async (adapter: AgentAdapter): Promise<DirectAgentTurnOutcome> => {
      const start = Date.now();
      const assignmentId = `direct-${adapter.id}-${randomUUID().slice(0, 8)}`;
      const assignment: AgentAssignment = {
        id: assignmentId,
        taskId: 'DIRECT',
        agentId: adapter.id,
        role: mutationAllowed ? 'implementer' : 'researcher',
        objective: prompt,
        status: 'running',
      };
      const lastSeen = { line: '' };
      const context: AgentContext = {
        worktreePath: this.repoRoot,
        originalUserRequest: prompt,
        priorContext: options.priorContext,
        conversationHistory: historySnapshot || undefined,
        directMode: true,
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
          const line = formatStreamLine(adapter.name, ev);
          if (line && line !== lastSeen.line) {
            lastSeen.line = line;
            this.onLiveLine?.(`${line}\n`);
          }
        },
      };

      try {
        const res = await adapter.execute(assignment, context);
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

    if (mutationAllowed && outcomes.length === 1) {
      const afterDirty = await snapshotDirtyFiles(this.repoRoot, this.gitService);
      outcomes[0].filesChanged = [...afterDirty].filter((f) => !beforeDirty.has(f));
    }

    for (const outcome of outcomes) {
      if (outcome.response) {
        this.memory.record({
          kind: 'agent',
          agentId: outcome.agentId,
          agentName: outcome.agentName,
          response: outcome.response,
          durationMs: outcome.durationMs,
          filesChanged: outcome.filesChanged,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const sections: string[] = [];
    if (unavailable.length > 0) {
      sections.push(`  ${colors.yellow}⚠ Skipped unavailable:${colors.reset} ${unavailable.join(', ')}`);
    }
    if (isMultiAgent && intent.mutationAllowed) {
      sections.push(
        `  ${colors.dim}Note: multi-agent direct turns run read-only so agents do not overwrite each other. Use a single @agent to apply edits directly, or omit @ for isolated parallel worktrees.${colors.reset}`,
      );
    }

    for (const outcome of outcomes) {
      const secs = `${(outcome.durationMs / 1000).toFixed(1)}s`;
      const tokensNote =
        outcome.tokensUsed && outcome.tokensUsed > 0
          ? ` · ${outcome.tokensUsed.toLocaleString('en-US')} tokens`
          : '';
      const statusBadge = outcome.success
        ? `${colors.green}✔${colors.reset}`
        : `${colors.red}✖${colors.reset}`;
      const header = `${statusBadge} ${colors.brand}${colors.bold}${outcome.agentName}${colors.reset} ${colors.dim}(${outcome.agentId} · ${secs}${tokensNote})${colors.reset}`;
      const body = outcome.success
        ? outcome.response
        : `${colors.red}${outcome.error || outcome.response}${colors.reset}`;
      const filesBlock =
        outcome.filesChanged.length > 0
          ? `\n  ${colors.cyan}Modified files:${colors.reset} ${outcome.filesChanged.join(', ')}`
          : '';
      sections.push(`${header}\n${body}${filesBlock}`);
    }

    return {
      formatted: sections.join(`\n\n${colors.darkGray}${'─'.repeat(60)}${colors.reset}\n\n`),
      outcomes,
    };
  }
}
