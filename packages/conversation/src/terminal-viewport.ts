import type { Writable } from 'node:stream';
import type readline from 'node:readline';
import { colors } from './theme.js';

export interface ViewportOptions {
  repoName?: string;
  branch?: string;
}

export class TerminalViewport {
  public readonly isInteractive: boolean;
  private rows: number;
  private cols: number;
  private scrollBottom: number;
  private repoName: string;
  private branch: string;
  private resizeListener?: () => void;
  private currentStatus = '';

  constructor(
    private outStream: Writable,
    options: ViewportOptions = {},
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
    this.scrollBottom = Math.max(5, this.rows - 3);
    this.repoName = options.repoName || 'repo';
    this.branch = options.branch || 'main';

    if (this.isInteractive) {
      this.resizeListener = () => this.handleResize();
      process.stdout.on('resize', this.resizeListener);
    }
  }

  public updateContext(repoName: string, branch: string) {
    this.repoName = repoName;
    this.branch = branch;
    if (this.isInteractive) {
      this.drawFooter(this.currentStatus);
    }
  }

  public init() {
    if (!this.isInteractive) return;
    // Set scrolling margin from line 1 to scrollBottom (e.g. rows - 3)
    this.outStream.write(`\x1b[1;${this.scrollBottom}r`);
    // Clear entire screen and position at 1,1
    this.outStream.write('\x1b[2J\x1b[1;1H');
    this.drawFooter('');
  }

  public cleanup() {
    if (!this.isInteractive) return;
    if (this.resizeListener) {
      process.stdout.off('resize', this.resizeListener);
    }
    // Reset terminal scrolling margin to full screen
    this.outStream.write('\x1b[r');
    // Position cursor at bottom row and ensure visible
    this.outStream.write(`\x1b[${this.rows};1H\n\x1b[?25h`);
  }

  private handleResize() {
    const streamAny = this.outStream as unknown as { rows?: number; columns?: number };
    this.rows = streamAny.rows || 24;
    this.cols = streamAny.columns || 80;
    this.scrollBottom = Math.max(5, this.rows - 3);
    this.outStream.write(`\x1b[1;${this.scrollBottom}r`);
    this.drawFooter(this.currentStatus);
  }

  /**
   * Writes content to the upper scrollable history viewport,
   * leaving the bottom input footer pinned and intact.
   */
  public writeUpper(content: string) {
    if (!this.isInteractive) {
      this.outStream.write(`${content}\n`);
      return;
    }
    // Save cursor position
    this.outStream.write('\x1b7');
    // Position cursor at bottom line of scrolling region
    this.outStream.write(`\x1b[${this.scrollBottom};1H`);
    const lines = content.split('\n');
    for (const line of lines) {
      this.outStream.write(`\n${line}`);
    }
    // Restore cursor position
    this.outStream.write('\x1b8');
  }

  /**
   * Redraws the pinned bottom 3 lines:
   * [rows - 2]: divider line ───
   * [rows - 1]: ╭─ ✦ TaskForge [repo • branch] [Status]
   * [rows]:     cleared and ready for prompt ╰─❯
   */
  public drawFooter(status = '') {
    this.currentStatus = status;
    if (!this.isInteractive) return;
    const dividerWidth = Math.min(this.cols, 65);
    const divider = '─'.repeat(dividerWidth);
    const statusPart = status ? ` ${colors.yellow}[${status}]${colors.reset}` : '';
    const branchLabel = `${colors.yellow}${this.branch}${colors.reset}`;
    const repoLabel = `${colors.cyan}${this.repoName}${colors.reset}`;

    // Save cursor
    this.outStream.write('\x1b7');
    // Row rows - 2: divider
    this.outStream.write(`\x1b[${this.rows - 2};1H\x1b[2K${colors.darkGray}${divider}${colors.reset}`);
    // Row rows - 1: header box
    this.outStream.write(
      `\x1b[${this.rows - 1};1H\x1b[2K${colors.brand}╭─${colors.reset} ${colors.bold}✦ TaskForge${colors.reset} ${colors.gray}[${colors.reset}${repoLabel} ${colors.gray}•${colors.reset} ${branchLabel}${colors.gray}]${colors.reset}${statusPart}`,
    );
    // Row rows: clear row for prompt
    this.outStream.write(`\x1b[${this.rows};1H\x1b[2K`);
    // Restore cursor
    this.outStream.write('\x1b8');
  }

  /**
   * Prepares the cursor position and prompt for readline
   */
  public preparePrompt(rl: readline.Interface) {
    if (!this.isInteractive) {
      rl.prompt();
      return;
    }
    this.drawFooter('');
    this.outStream.write(`\x1b[${this.rows};1H\x1b[2K`);
    rl.setPrompt(`${colors.brand}╰─${colors.green}❯${colors.reset} `);
    rl.prompt();
  }
}
