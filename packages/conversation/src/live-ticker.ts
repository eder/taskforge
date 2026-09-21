import { ActiveAgentState } from '@taskforge/shared';
import { AgentQuotaTracker } from '@taskforge/agents';
import { colors } from './theme.js';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface LiveTickerRenderOptions {
  activeAgents: ActiveAgentState[];
  registeredAgents?: Array<{ id: string; name: string }>;
  frameIndex?: number;
  terminalCols?: number;
}

export class LiveTicker {
  public static formatDuration(startedAt: Date): string {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
    if (elapsedSeconds < 60) {
      return `${elapsedSeconds}s`;
    }
    const mins = Math.floor(elapsedSeconds / 60);
    const secs = elapsedSeconds % 60;
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }

  public static getAgentColor(agentId: string): string {
    const id = agentId.toLowerCase();
    if (id.includes('claude')) return colors.coral;
    if (id.includes('codex')) return colors.green;
    if (id.includes('antigravity') || id.includes('agy')) return colors.brand;
    if (id.includes('gemini')) return colors.magenta;
    return colors.cyan;
  }

  public static render(options: LiveTickerRenderOptions): string[] {
    const { activeAgents, registeredAgents = [], frameIndex = 0 } = options;

    if (activeAgents.length === 0) {
      return [];
    }

    const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const lines: string[] = [];

    // Check if any active agent requires operator attention (human-in-the-loop)
    const urgentAgent = activeAgents.find((a) => a.attentionRequired);
    if (urgentAgent && urgentAgent.attentionRequired) {
      const att = urgentAgent.attentionRequired;
      const promptSnippet = att.prompt.length > 50 ? `${att.prompt.slice(0, 47)}...` : att.prompt;
      lines.push(
        `  ${colors.yellow}${colors.bold}▲ ATTENTION${colors.reset} [${urgentAgent.taskId}: ${urgentAgent.agentName}]: ${promptSnippet} ${colors.dim}(type "allow" or "/deny")${colors.reset}`,
      );
    }

    // Check if any active agent has critical review findings to highlight inline
    for (const a of activeAgents) {
      if (a.criticalFindings && a.criticalFindings.length > 0) {
        for (const finding of a.criticalFindings.slice(0, 2)) {
          const loc = finding.file
            ? `${colors.yellow}${colors.bold}${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}${colors.reset}`
            : '';
          const locPrefix = loc ? ` ${loc} •` : '';
          const descSnippet =
            finding.description.length > 50
              ? `${finding.description.slice(0, 47)}...`
              : finding.description;
          lines.push(
            `  ${colors.red}${colors.bold}✖ [${finding.severity.toUpperCase()}]${colors.reset} ${colors.bold}${a.taskId}${colors.reset}:${locPrefix} ${descSnippet}`,
          );
        }
      }
    }

    // Active agent status lines (limit to 3 if many)
    const displayedAgents = activeAgents.slice(0, 3);
    for (const a of displayedAgents) {
      const agentColor = this.getAgentColor(a.agentId);
      const duration = this.formatDuration(a.startedAt);
      const statusText = a.status.length > 50 ? `${a.status.slice(0, 47)}...` : a.status;
      const recovered =
        a.recovery && new Date(a.recovery.recoveredUntil).getTime() > Date.now();
      const recoveryTag = recovered
        ? ` ${colors.green}${colors.bold}↻ recovered${colors.reset}`
        : '';
      lines.push(
        `  ${colors.cyan}${spinner}${colors.reset} ${colors.bold}${a.taskId}${colors.reset} ${agentColor}[${a.agentName}]${colors.reset}${recoveryTag}: ${statusText} ${colors.dim}(${duration})${colors.reset}`,
      );
    }

    if (activeAgents.length > 3) {
      lines.push(
        `  ${colors.dim}... and ${activeAgents.length - 3} more agent(s) working concurrently${colors.reset}`,
      );
    }

    // Free agents summary & shortcut hint. Excludes agents currently sitting
    // out a quota/rate-limit cooldown — they aren't actually available for
    // new work even though they're not in `activeAgents`.
    const quotaTracker = AgentQuotaTracker.getInstance();
    const activeAgentIds = new Set(activeAgents.map((a) => a.agentId));
    const freeAgents = registeredAgents.filter(
      (r) => !activeAgentIds.has(r.id) && quotaTracker.isAvailable(r.id),
    );
    const onCooldown = registeredAgents.filter(
      (r) => !activeAgentIds.has(r.id) && !quotaTracker.isAvailable(r.id),
    );
    const freeText =
      freeAgents.length > 0
        ? `Free: ${freeAgents.map((f) => f.name).join(', ')}`
        : 'All registered agents active';
    const cooldownText =
      onCooldown.length > 0 ? `  •  On cooldown: ${onCooldown.map((f) => f.name).join(', ')}` : '';

    lines.push(
      `  ${colors.dim}○ ${freeText}${cooldownText}  •  Type /stream <task> to inspect  •  REPL is ready${colors.reset}`,
    );

    return lines;
  }
}
