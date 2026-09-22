import type { Writable } from 'node:stream';
import { colors } from './theme.js';

export interface SlashCommandItem {
  cmd: string;
  desc: string;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  { cmd: '/help', desc: 'Display the complete command reference' },
  { cmd: '/health', desc: 'Inspect Router, agents, provider quota, and local database health' },
  { cmd: '/plan', desc: 'Inspect the current proposed or active plan' },
  { cmd: '/runs', desc: 'List past execution runs and delivery status' },
  { cmd: '/inspect', desc: 'Inspect run → task → assignment history; accepts an optional run id' },
  { cmd: '/tasks', desc: 'List task and assignment status for the current run' },
  { cmd: '/status', desc: 'Open the full TUI dashboard' },
  { cmd: '/agents', desc: 'Inspect detected AI agent harnesses and availability' },
  { cmd: '/stream', desc: 'Enter live output for the active task or assignment' },
  { cmd: '/focus', desc: 'Focus one active agent by index, e.g. /focus 2' },
  { cmd: '/back', desc: 'Leave agent Focus Mode and return to the overview' },
  { cmd: '/raw', desc: 'Show persisted raw provider output; accepts an optional agent index' },
  { cmd: '/pending', desc: 'View interactions awaiting human approval' },
  { cmd: '/approve', desc: 'Approve the plan or a pending interaction' },
  { cmd: '/deny', desc: 'Deny a pending interaction' },
  { cmd: '/reject', desc: 'Reject the current plan with optional feedback' },
  { cmd: '/constraint', desc: 'Add a constraint to the current plan' },
  { cmd: '/reassign', desc: 'Reassign a task or role to another healthy agent' },
  { cmd: '/cancel', desc: 'Cancel the active run or one focused assignment' },
  { cmd: '/pause', desc: 'Pause orchestrator execution' },
  { cmd: '/resume', desc: 'Resume paused execution' },
  { cmd: '/cost', desc: 'Show token usage and financial cost report' },
  { cmd: '/stats', desc: 'Show execution and orchestration efficiency metrics' },
  { cmd: '/diff', desc: 'Inspect changes from a completed run' },
  { cmd: '/apply', desc: 'Apply a completed run to its target branch' },
  { cmd: '/pr', desc: 'Create a pull request for a completed run' },
  { cmd: '/discard', desc: 'Discard delivery while keeping the integration branch' },
  { cmd: '/clean', desc: 'Clean temporary worktrees and branches' },
  { cmd: '/exit', desc: 'Exit the interactive session' },
]

export class SlashMenu {
  public isOpen = false;
  public selectedIndex = 0;
  public scrollOffset = 0;
  public matches: SlashCommandItem[] = [];
  public menuHeight = 0;
  private readonly isInteractive: boolean;
  private rows: number;
  private cols: number;

  constructor(
    private outStream: Writable,
    private commands: SlashCommandItem[] = SLASH_COMMANDS,
  ) {
    const streamAny = outStream as unknown as { isTTY?: boolean; rows?: number; columns?: number };
    this.isInteractive = Boolean(
      streamAny.isTTY &&
      process.stdin.isTTY &&
      typeof streamAny.rows === 'number' &&
      streamAny.rows > 10 &&
      outStream === process.stdout,
    );
    this.rows = streamAny.rows || 24;
    this.cols = streamAny.columns || 80;
  }

  public update(line: string, isBackspace = false): { autoCompleted?: string } {
    if (!line.startsWith('/') || line.includes(' ')) {
      this.close();
      return {};
    }

    const search = line.trim().toLowerCase();
    this.matches = this.commands.filter((c) => c.cmd.startsWith(search));

    if (this.matches.length === 0) {
      this.close();
      return {};
    }

    this.isOpen = true;
    if (this.selectedIndex >= this.matches.length) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    }

    // Autocomplete unique match when user typed more than just "/" and did not press backspace
    let autoCompleted: string | undefined;
    if (
      !isBackspace &&
      this.matches.length === 1 &&
      line.length > 1 &&
      line !== this.matches[0].cmd
    ) {
      autoCompleted = this.matches[0].cmd;
    }

    this.render();
    return { autoCompleted };
  }

  public selectNext() {
    if (!this.isOpen || this.matches.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.matches.length;
    this.render();
  }

  public selectPrev() {
    if (!this.isOpen || this.matches.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.matches.length) % this.matches.length;
    this.render();
  }

  public getSelected(): SlashCommandItem | undefined {
    if (!this.isOpen || this.matches.length === 0) return undefined;
    return this.matches[this.selectedIndex];
  }

  public close() {
    if (!this.isOpen && this.menuHeight === 0) return;
    this.clear();
    this.isOpen = false;
    this.matches = [];
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public render() {
    if (!this.isInteractive) return;

    const streamAny = this.outStream as unknown as { rows?: number; columns?: number };
    this.rows = streamAny.rows || 24;
    this.cols = streamAny.columns || 80;

    const maxVisible = Math.max(1, Math.min(6, this.matches.length));
    const boxHeight = maxVisible + 2;

    // Clear previous menu if dimensions changed
    if (this.menuHeight > 0 && this.menuHeight !== boxHeight) {
      this.clear();
    }

    // Keep selectedIndex visible within scroll window
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.selectedIndex - maxVisible + 1;
    }

    // Place menu directly above persistent bottom input line (which sits at rows)
    const startRow = Math.max(1, this.rows - boxHeight);

    // Save cursor position
    this.outStream.write('\x1b7');

    const totalWidth = Math.min(this.cols - 4, 68);
    const innerWidth = totalWidth - 2;

    // Top border
    const title = '✦ Commands';
    const topBarLen = Math.max(0, innerWidth - title.length - 4);
    const topBorder = `${colors.brand}╭── ${colors.bold}${title}${colors.reset}${colors.brand} ${'─'.repeat(topBarLen)}╮${colors.reset}`;
    this.outStream.write(`\x1b[${startRow};1H\x1b[2K ${topBorder}`);

    // Render command items
    for (let i = 0; i < maxVisible; i++) {
      const itemIndex = this.scrollOffset + i;
      const item = this.matches[itemIndex];
      const isSelected = itemIndex === this.selectedIndex;
      const row = startRow + 1 + i;

      if (!item) {
        this.outStream.write(`\x1b[${row};1H\x1b[2K`);
        continue;
      }

      const marker = isSelected ? `${colors.green}❯${colors.reset}` : ' ';
      const desc = item.desc;

      const cmdFormatted = isSelected
        ? `${colors.bold}${colors.cyan}${item.cmd.padEnd(11)}${colors.reset}`
        : `${colors.cyan}${item.cmd.padEnd(11)}${colors.reset}`;

      const maxDescLen = Math.max(10, innerWidth - 18);
      const truncatedDesc = desc.length > maxDescLen ? `${desc.slice(0, maxDescLen - 1)}…` : desc;
      const descPadded = truncatedDesc.padEnd(maxDescLen);

      const descFormatted = isSelected
        ? `${colors.bold}${colors.white}${descPadded}${colors.reset}`
        : `${colors.darkGray}${descPadded}${colors.reset}`;

      this.outStream.write(
        `\x1b[${row};1H\x1b[2K ${colors.brand}│${colors.reset}  ${marker} ${cmdFormatted} ${descFormatted} ${colors.brand}│${colors.reset}`,
      );
    }

    // Bottom border with navigation hints
    const bottomRow = startRow + boxHeight - 1;
    const hint = '↑/↓ browse • Tab complete • Esc close';
    const bottomBarLen = Math.max(0, innerWidth - hint.length - 4);
    const bottomBorder = `${colors.brand}╰── ${colors.dim}${hint}${colors.reset}${colors.brand} ${'─'.repeat(bottomBarLen)}╯${colors.reset}`;
    this.outStream.write(`\x1b[${bottomRow};1H\x1b[2K ${bottomBorder}`);

    // Restore cursor position in readline prompt
    this.outStream.write('\x1b8');

    this.menuHeight = boxHeight;
  }

  public clear() {
    if (!this.isInteractive || this.menuHeight === 0) return;
    const streamAny = this.outStream as unknown as { rows?: number };
    const rows = streamAny.rows || 24;
    const startRow = Math.max(1, rows - this.menuHeight);

    this.outStream.write('\x1b7');
    for (let i = 0; i < this.menuHeight; i++) {
      this.outStream.write(`\x1b[${startRow + i};1H\x1b[2K`);
    }
    this.outStream.write('\x1b8');
    this.menuHeight = 0;
  }
}
