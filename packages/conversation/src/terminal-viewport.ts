import type { Writable } from 'node:stream';
import type readline from 'node:readline';
import { colors } from './theme.js';

export interface ViewportOptions {
  repoName?: string;
  branch?: string;
}

export class TerminalViewport {
  public readonly isInteractive: boolean;
  public rows: number;
  public cols: number;
  public scrollBottom: number;
  private currentBuffer = '';
  private currentCursorIndex = 0;
  private currentStatus = '';
  private currentPanelLines: string[] = [];
  private repoName: string;
  private branch: string;
  private resizeListener?: () => void;

  constructor(
    private outStream: Writable,
    options: ViewportOptions = {},
  ) {
    const streamAny = outStream as unknown as { isTTY?: boolean; rows?: number; columns?: number };
    this.isInteractive = Boolean(
      streamAny.isTTY &&
      process.stdin.isTTY &&
      typeof streamAny.rows === 'number' &&
      streamAny.rows > 6 &&
      outStream === process.stdout,
    );

    this.rows = streamAny.rows || 24;
    this.cols = streamAny.columns || 80;
    this.scrollBottom = Math.max(3, this.rows - 1);
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
  }

  public init() {
    if (!this.isInteractive) return;
    this.scrollBottom = Math.max(3, this.rows - 1);
    // Set scrolling margin from row 1 to rows - 1 (row `rows` is reserved for persistent input)
    this.outStream.write(`\x1b[1;${this.scrollBottom}r`);
    // Clear entire screen and position at top left
    this.outStream.write('\x1b[2J\x1b[1;1H');
    this.renderInputLine('', 0, '', []);
  }

  public cleanup() {
    if (!this.isInteractive) return;
    if (this.resizeListener) {
      process.stdout.off('resize', this.resizeListener);
    }
    // Reset terminal scrolling margin to full screen
    this.outStream.write('\x1b[r');
    // Position cursor at bottom row, show cursor, newline
    this.outStream.write(`\x1b[${this.rows};1H\n\x1b[?25h`);
  }

  public handleResize(onResize?: () => void) {
    const streamAny = this.outStream as unknown as { rows?: number; columns?: number };
    this.rows = streamAny.rows || 24;
    this.cols = streamAny.columns || 80;
    this.scrollBottom = Math.max(3, this.rows - 1);
    this.outStream.write(`\x1b[1;${this.scrollBottom}r`);
    this.renderInputLine(this.currentBuffer, this.currentCursorIndex, this.currentStatus, this.currentPanelLines);
    onResize?.();
  }

  /**
   * Writes content to the upper scrollable history viewport,
   * leaving the bottom input line pinned and intact.
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

    // Immediately re-anchor and redraw the persistent bottom input line
    this.renderInputLine(this.currentBuffer, this.currentCursorIndex, this.currentStatus, this.currentPanelLines);
  }

  /**
   * Renders the persistent bottom input line at row `rows`.
   * The line begins with `> `.
   * Cursor is placed right after `> ` + cursorIndex.
   */
  public renderInputLine(buffer: string, cursorIndex: number, status = '', panelLines?: string[]) {
    this.currentBuffer = buffer;
    this.currentCursorIndex = cursorIndex;
    this.currentStatus = status;
    const prevPanelHeight = Math.min(this.currentPanelLines.length, Math.max(0, this.rows - 6));
    if (panelLines !== undefined) {
      this.currentPanelLines = panelLines;
    }

    if (!this.isInteractive) return;

    const panelHeight = Math.min(this.currentPanelLines.length, Math.max(0, this.rows - 6));
    const targetScrollBottom = Math.max(3, this.rows - panelHeight - 1);
    if (targetScrollBottom !== this.scrollBottom) {
      this.scrollBottom = targetScrollBottom;
      this.outStream.write(`\x1b[1;${this.scrollBottom}r`);
    }

    // Clear old panel rows if panel shrunk
    if (panelHeight < prevPanelHeight) {
      for (let r = this.rows - prevPanelHeight; r < this.rows; r++) {
        this.outStream.write(`\x1b[${r};1H\x1b[2K`);
      }
    }

    // Render panel lines if any
    if (panelHeight > 0) {
      const startRow = this.rows - panelHeight;
      for (let i = 0; i < panelHeight; i++) {
        const row = startRow + i;
        this.outStream.write(`\x1b[${row};1H\x1b[2K${this.currentPanelLines[i]}`);
      }
    }

    const promptStr = `${colors.bold}${colors.green}>${colors.reset} `;
    const promptLen = 2; // length of "> " without ANSI escape codes

    let lineContent = `${promptStr}${buffer}`;
    if (status) {
      lineContent += ` ${colors.dim}[${status}]${colors.reset}`;
    }

    // Move to bottom row, column 1, clear line, write prompt and buffer
    this.outStream.write(`\x1b[${this.rows};1H\x1b[2K${lineContent}`);

    // Place cursor right after prompt + cursorIndex
    const targetCol = promptLen + cursorIndex + 1;
    this.outStream.write(`\x1b[${this.rows};${targetCol}H`);
  }

  /**
   * Backward-compatible helper for code expecting drawFooter / preparePrompt
   */
  public drawFooter(status = '', panelLines?: string[]) {
    this.renderInputLine(this.currentBuffer, this.currentCursorIndex, status, panelLines);
  }

  public preparePrompt(_rl?: readline.Interface) {
    this.renderInputLine('', 0, '', this.currentPanelLines);
  }
}
