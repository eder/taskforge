import * as fs from 'node:fs';
import { ActiveAgentState } from '@taskforge/shared';
import { colors } from './theme.js';

export interface StreamViewerOptions {
  activeAgent: ActiveAgentState;
  allActive?: ActiveAgentState[];
  maxLines?: number;
}

export class StreamViewer {
  public static getStreamSnapshot(options: StreamViewerOptions): string {
    const { activeAgent, allActive = [activeAgent], maxLines = 15 } = options;

    let logContent = 'No output recorded yet. Agent is initializing...';
    if (activeAgent.logPath && fs.existsSync(activeAgent.logPath)) {
      try {
        const raw = fs.readFileSync(activeAgent.logPath, 'utf8');
        const lines = raw.split('\n');
        const recent = lines.slice(-maxLines).join('\n').trim();
        if (recent.length > 0) {
          logContent = recent;
        }
      } catch {
        // fallback
      }
    }

    const tabs = allActive
      .map((a, idx) => {
        const isCurrent = a.taskId === activeAgent.taskId;
        const tag = `[${idx + 1}: ${a.taskId}]`;
        return isCurrent ? `${colors.bold}${colors.cyan}${tag}${colors.reset}` : `${colors.dim}${tag}${colors.reset}`;
      })
      .join(' ');

    const header = `  ${colors.brand}┌─ [Live Stream: ${colors.bold}${activeAgent.taskId}${colors.reset}${colors.brand} (${activeAgent.agentName})] ─── ${tabs}${colors.brand} ───${colors.reset}`;
    const divider = `  ${colors.brand}└${'─'.repeat(70)}┘${colors.reset}`;
    const footer = `  ${colors.dim}Press [Esc] or type 'q' to return to prompt  •  [1-9] Switch Agent${colors.reset}`;

    return [header, '', logContent, '', divider, footer].join('\n');
  }
}
