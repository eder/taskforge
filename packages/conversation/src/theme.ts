/**
 * TaskForge CLI Theme & Styling System
 * Inspired by modern AI coding interfaces (Claude Code, OpenAI Codex, Google Antigravity)
 */

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Modern 256-color palette
  brand: '\x1b[38;5;141m',       // Soft Lilac / Purple (Claude/TaskForge signature)
  brandLight: '\x1b[38;5;183m',  // Light Lilac
  cyan: '\x1b[38;5;75m',         // Electric Sky Blue / Cyan (Antigravity)
  cyanLight: '\x1b[38;5;117m',   // Ice Cyan
  green: '\x1b[38;5;78m',        // Mint Emerald Green (Codex / Success)
  greenLight: '\x1b[38;5;120m',  // Spring Green
  yellow: '\x1b[38;5;215m',      // Warm Amber / Gold (Warning / Attention)
  coral: '\x1b[38;5;209m',       // Terracotta / Peach (Claude Agent)
  red: '\x1b[38;5;203m',         // Coral Red (Error / Failure)
  magenta: '\x1b[38;5;177m',     // Orchid Magenta (Gemini Agent)
  gray: '\x1b[38;5;244m',        // Medium Slate Gray
  darkGray: '\x1b[38;5;239m',    // Dark Slate Gray
  lightGray: '\x1b[38;5;250m',   // Near White Gray
  white: '\x1b[97m',             // Pure Bright White
};

export const theme = {
  brand: (s: string) => `${colors.brand}${s}${colors.reset}`,
  brandBold: (s: string) => `${colors.bold}${colors.brand}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  cyanBold: (s: string) => `${colors.bold}${colors.cyan}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  greenBold: (s: string) => `${colors.bold}${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  yellowBold: (s: string) => `${colors.bold}${colors.yellow}${s}${colors.reset}`,
  coral: (s: string) => `${colors.coral}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  redBold: (s: string) => `${colors.bold}${colors.red}${s}${colors.reset}`,
  magenta: (s: string) => `${colors.magenta}${s}${colors.reset}`,
  dim: (s: string) => `${colors.gray}${s}${colors.reset}`,
  dark: (s: string) => `${colors.darkGray}${s}${colors.reset}`,
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,

  agentPill: (id: string, name: string, ready: boolean): string => {
    let color = colors.cyan;
    if (id.includes('claude')) color = colors.coral;
    else if (id.includes('codex')) color = colors.green;
    else if (id.includes('agy') || id.includes('antigravity')) color = colors.brand;
    else if (id.includes('gemini')) color = colors.magenta;

    const icon = ready ? `${colors.green}●${colors.reset}` : `${colors.darkGray}○${colors.reset}`;
    const statusText = ready
      ? `${colors.green}ready${colors.reset}`
      : `${colors.darkGray}not detected${colors.reset}`;

    return `${icon} ${color}${colors.bold}${name.padEnd(18)}${colors.reset} ${colors.dim}[${id.padEnd(7)}]${colors.reset} ${statusText}`;
  },

  statusBadge: (status: string): string => {
    const s = status.toUpperCase();
    switch (s) {
      case 'INTEGRATED':
      case 'VERIFIED':
      case 'COMPLETED':
        return `${colors.green}${colors.bold}✓ ${s}${colors.reset}`;
      case 'RUNNING':
      case 'VERIFICATION':
        return `${colors.yellow}${colors.bold}⚡ ${s}${colors.reset}`;
      case 'READY':
      case 'ACCEPTED':
      case 'ASSIGNED':
        return `${colors.cyan}${colors.bold}○ ${s}${colors.reset}`;
      case 'FAILED':
      case 'BLOCKED':
        return `${colors.red}${colors.bold}✕ ${s}${colors.reset}`;
      default:
        return `${colors.gray}${s}${colors.reset}`;
    }
  },

  box: (title: string, lines: string[], width: number = 64): string => {
    const top = `${colors.brand}╭─${colors.reset} ${colors.bold}${title}${colors.reset} ${colors.brand}${'─'.repeat(Math.max(2, width - title.length - 5))}╮${colors.reset}`;
    const bottom = `${colors.brand}╰${'─'.repeat(width)}╯${colors.reset}`;
    const formatted = lines.map((l) => `${colors.brand}│${colors.reset}  ${l}`);
    return [top, ...formatted, bottom].join('\n');
  },

  taskTypeIcon: (type: string): string => {
    switch (type.toLowerCase()) {
      case 'investigation':
        return '🔍';
      case 'implementation':
        return '🛠️ ';
      case 'review':
        return '🛡️ ';
      case 'test':
        return '🧪';
      case 'documentation':
        return '📝';
      default:
        return '✦ ';
    }
  },

  prompt: (branch: string, repoName: string): string => {
    const branchLabel = branch ? `${colors.yellow}${branch}${colors.reset}` : 'unknown';
    const repoLabel = repoName ? `${colors.cyan}${repoName}${colors.reset}` : 'repo';

    return `${colors.brand}╭─${colors.reset} ${colors.bold}✦ TaskForge${colors.reset} ${colors.gray}[${colors.reset}${repoLabel} ${colors.gray}•${colors.reset} ${branchLabel}${colors.gray}]${colors.reset}\n${colors.brand}╰─${colors.green}❯${colors.reset} `;
  },

  formatProgressMessage: (msg: string): string => {
    // If it's a task step
    const taskMatch = msg.match(/^\[(TASK-[^\]]+)\]\s*(.*)$/);
    if (taskMatch) {
      const [, taskId, rest] = taskMatch;
      const tid = `${colors.cyan}${colors.bold}[${taskId}]${colors.reset}`;

      if (rest.includes('Assigned to')) {
        return `  ${colors.brand}✦${colors.reset} ${tid} ${colors.bold}${rest}${colors.reset}`;
      }
      if (rest.includes('Created isolated worktree')) {
        return `  ${colors.gray}│${colors.reset}  ${colors.cyan}📁${colors.reset} ${colors.dim}${rest}${colors.reset}`;
      }
      if (rest.startsWith('Output:\n')) {
        const body = rest.replace(/^Output:\n/, '');
        return `\n${colors.brand}╭── ✦ Agent Analysis ${tid} ──────────────────────────────────────╮${colors.reset}\n${body}\n${colors.brand}╰────────────────────────────────────────────────────────────────╯${colors.reset}\n`;
      }
      if (rest.includes('executing...')) {
        return `  ${colors.gray}│${colors.reset}  ${colors.yellow}⚡${colors.reset} ${rest}`;
      }
      if (rest.includes('completed (status:')) {
        return `  ${colors.gray}│${colors.reset}  ${colors.green}✔${colors.reset} ${colors.green}${rest}${colors.reset}`;
      }
      if (rest.includes('Running verification')) {
        return `  ${colors.gray}│${colors.reset}  ${colors.yellow}🧪${colors.reset} ${rest}`;
      }
      if (rest.includes('Verified successfully')) {
        return `  ${colors.gray}│${colors.reset}  ${colors.green}✔${colors.reset} ${colors.green}${colors.bold}${rest}${colors.reset}`;
      }
      if (rest.includes('Integrating commit')) {
        return `  ${colors.gray}│${colors.reset}  ${colors.cyan}🔀${colors.reset} ${rest}`;
      }
      if (rest.includes('Integrated successfully')) {
        return `  ${colors.brand}└─${colors.reset} ${colors.green}✔${colors.reset} ${colors.green}${colors.bold}${rest}${colors.reset}\n`;
      }
      if (rest.includes('Verification failed') || rest.includes('failed')) {
        return `  ${colors.gray}│${colors.reset}  ${colors.red}✕${colors.reset} ${colors.red}${rest}${colors.reset}`;
      }
      return `  ${colors.gray}│${colors.reset}  ${tid} ${rest}`;
    }

    if (msg.includes('Plan approved')) {
      return `\n${colors.brand}╭── ✦ TaskForge Execution ───────────────────────────────────────╮${colors.reset}\n${colors.brand}│${colors.reset}  ${colors.green}✔${colors.reset} ${colors.bold}${msg}${colors.reset}`;
    }
    if (msg.includes('Starting TaskForge orchestrator')) {
      return `${colors.brand}│${colors.reset}  ${colors.cyan}ℹ${colors.reset} ${colors.dim}${msg}${colors.reset}`;
    }
    if (msg.includes('Scheduling')) {
      return `${colors.brand}│${colors.reset}  ${colors.brand}⚡${colors.reset} ${colors.bold}${msg}${colors.reset}\n${colors.brand}│${colors.reset}`;
    }
    if (msg.includes('Run finished with status')) {
      return `${colors.brand}╰─────────────────────────────────────────────────────────────────╯${colors.reset}\n  ${colors.green}✔${colors.reset} ${colors.bold}${msg}${colors.reset}`;
    }

    return `  ${colors.dim}[TaskForge]${colors.reset} ${msg}`;
  },
};
