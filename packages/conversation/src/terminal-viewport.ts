import type { Writable } from 'node:stream';
import type readline from 'node:readline';
import { colors } from './theme.js';

export interface ViewportOptions {
  repoName?: string;
  branch?: string;
  interactive?: boolean;
}

export interface FocusShortcutContext {
  str?: string;
  key?: readline.Key;
  buffer: string;
  focused: boolean;
  onSwitch: (indexOneBased: number) => string;
  onExit: () => string;
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

  private prevInputHeight = 1;
  private prevPanelHeight = 0;

  constructor(
    private outStream: Writable,
    options: ViewportOptions = {},
  ) {
    const streamAny = outStream as unknown as { isTTY?: boolean; rows?: number; columns?: number };
    this.isInteractive = options.interactive !== undefined
      ? options.interactive
      : Boolean(
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
    // Enable bracketed paste mode
    this.outStream.write('\x1b[?2004h');
    this.renderInputLine('', 0, '', []);
  }

  public cleanup() {
    if (!this.isInteractive) return;
    if (this.resizeListener) {
      process.stdout.off('resize', this.resizeListener);
    }
    // Disable bracketed paste mode
    this.outStream.write('\x1b[?2004l');
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
   * Handles Focus Mode's single-keystroke navigation inside the interactive
   * terminal boundary. The shortcut is deliberately conservative: it only
   * consumes 1-9 or Esc when an assignment is already focused and the prompt
   * buffer is empty. Every other key falls through to the normal line editor.
   *
   * The shell owns focus state; the viewport owns the raw terminal gesture and
   * renders the resulting focus/overview view into scrollback.
   */
  public handleFocusShortcut(context: FocusShortcutContext): boolean {
    if (!this.isInteractive || !context.focused || context.buffer.trim().length !== 0) {
      return false;
    }

    const { str, key } = context;

    let response: string | undefined;
    const digit =
      !key?.ctrl &&
      !key?.meta &&
      !key?.shift &&
      str &&
      /^[1-9]$/.test(str)
        ? Number(str)
        : !key?.ctrl &&
            !key?.meta &&
            !key?.shift &&
            key?.name &&
            /^[1-9]$/.test(key.name)
          ? Number(key.name)
          : undefined;

    if (digit !== undefined) {
      response = context.onSwitch(digit);
    } else if (key?.name === 'escape' || str === '\x1b') {
      response = context.onExit();
    } else {
      return false;
    }

    if (response) {
      this.writeUpper(response);
    }
    return true;
  }

  /**
   * Writes content to the upper scrollable history viewport,
   * leaving the bottom input lines pinned and intact.
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
   * Computes visual lines and cursor coordinates for wrapped multiline rendering.
   */
  public computeVisualLines(
    buffer: string,
    cursorIndex: number,
  ): {
    visualLines: string[];
    cursorVisualLine: number;
    cursorVisualCol: number;
  } {
    const promptLen = 2; // visual width of "> " or "  "
    const maxCols = Math.max(20, this.cols || 80);
    const availWidth = Math.max(10, maxCols - promptLen - 2);

    if (!buffer) {
      return {
        visualLines: [''],
        cursorVisualLine: 0,
        cursorVisualCol: promptLen + 1,
      };
    }

    const visualLines: string[] = [];
    let cursorVisualLine = 0;
    let cursorVisualCol = promptLen + 1;
    let cursorPlaced = false;

    // Split paragraphs by explicit newline
    const paras = buffer.split('\n');
    let charOffset = 0;

    for (let pIdx = 0; pIdx < paras.length; pIdx++) {
      const para = paras[pIdx];
      const isLastPara = pIdx === paras.length - 1;
      const paraLen = para.length;
      const paraEnd = charOffset + paraLen; // not including '\n'

      if (paraLen === 0) {
        // Empty paragraph line
        const lineText = isLastPara ? '' : ' ↵ ';
        const vLineIdx = visualLines.length;
        visualLines.push(lineText);

        if (!cursorPlaced && cursorIndex <= charOffset) {
          cursorVisualLine = vLineIdx;
          cursorVisualCol = promptLen + 1;
          cursorPlaced = true;
        }

        charOffset += 1; // account for '\n'
        continue;
      }

      // If paragraph fits on one visual line
      if (paraLen <= availWidth) {
        const lineText = isLastPara ? para : `${para} ↵ `;
        const vLineIdx = visualLines.length;
        visualLines.push(lineText);

        if (!cursorPlaced && cursorIndex <= (isLastPara ? paraEnd : paraEnd + 1)) {
          const colOffset = Math.min(paraLen, Math.max(0, cursorIndex - charOffset));
          cursorVisualLine = vLineIdx;
          cursorVisualCol = promptLen + colOffset + 1;
          cursorPlaced = true;
        }
      } else {
        // Wrap long paragraph across multiple visual lines
        let pos = 0;
        while (pos < paraLen) {
          const remaining = paraLen - pos;
          let take = Math.min(remaining, availWidth);

          // Word wrap: look for whitespace before boundary
          if (remaining > availWidth) {
            let breakAt = -1;
            for (let i = pos + availWidth; i > pos + Math.floor(availWidth * 0.4); i--) {
              if (para[i] === ' ' || para[i] === '\t') {
                breakAt = i;
                break;
              }
            }
            if (breakAt !== -1) {
              take = breakAt - pos;
            }
          }

          const chunk = para.slice(pos, pos + take);
          const isLastChunk = pos + take >= paraLen;
          const lineText = isLastChunk && !isLastPara ? `${chunk} ↵ ` : chunk;
          const vLineIdx = visualLines.length;
          visualLines.push(lineText);

          const chunkStart = charOffset + pos;
          const chunkEnd = chunkStart + take;

          if (!cursorPlaced) {
            if (
              cursorIndex >= chunkStart &&
              (cursorIndex < chunkEnd ||
                (isLastChunk && cursorIndex <= (isLastPara ? chunkEnd : chunkEnd + 1)))
            ) {
              const colOffset = cursorIndex - chunkStart;
              cursorVisualLine = vLineIdx;
              cursorVisualCol = promptLen + colOffset + 1;
              cursorPlaced = true;
            }
          }

          pos += take;
          // Skip leading space of next wrapped line if broken on space
          if (pos < paraLen && para[pos] === ' ') {
            pos++;
          }
        }
      }

      charOffset = paraEnd + 1; // +1 for '\n'
    }

    if (!cursorPlaced) {
      cursorVisualLine = Math.max(0, visualLines.length - 1);
      const lastLineRaw = visualLines[cursorVisualLine].replace(/ ↵ $/, '');
      cursorVisualCol = promptLen + lastLineRaw.length + 1;
    }

    return { visualLines, cursorVisualLine, cursorVisualCol };
  }

  /**
   * Renders the persistent bottom input lines.
   * Dynamically expands from 1 up to maxInputHeight lines when text wraps or contains newlines.
   */
  public renderInputLine(buffer: string, cursorIndex: number, status = '', panelLines?: string[]) {
    this.currentBuffer = buffer;
    this.currentCursorIndex = cursorIndex;
    this.currentStatus = status;
    const prevPanelHeight = this.prevPanelHeight;
    const prevInputHeight = this.prevInputHeight;

    if (panelLines !== undefined) {
      this.currentPanelLines = panelLines;
    }

    if (!this.isInteractive) return;

    const { visualLines, cursorVisualLine, cursorVisualCol } = this.computeVisualLines(
      buffer,
      cursorIndex,
    );

    const maxInputHeight = Math.min(8, Math.max(1, Math.floor(this.rows / 3)));
    const inputHeight = Math.min(visualLines.length, maxInputHeight);

    let windowStart = 0;
    if (cursorVisualLine >= maxInputHeight) {
      windowStart = cursorVisualLine - maxInputHeight + 1;
    }
    const displayLines = visualLines.slice(windowStart, windowStart + inputHeight);
    const displayCursorLine = cursorVisualLine - windowStart;

    const panelHeight = Math.min(this.currentPanelLines.length, Math.max(0, this.rows - 6));
    const inputStartRow = this.rows - inputHeight + 1;
    const panelStartRow = inputStartRow - panelHeight;
    const targetScrollBottom = Math.max(3, panelStartRow - 1);

    if (targetScrollBottom !== this.scrollBottom) {
      this.scrollBottom = targetScrollBottom;
      this.outStream.write(`\x1b[1;${this.scrollBottom}r`);
    }

    // Clear old rows if total occupied bottom rows shrank
    const prevTotalRows = prevPanelHeight + prevInputHeight;
    const currentTotalRows = panelHeight + inputHeight;
    if (currentTotalRows < prevTotalRows) {
      const clearStart = this.rows - prevTotalRows + 1;
      const clearEnd = this.rows - currentTotalRows;
      for (let r = clearStart; r <= clearEnd; r++) {
        this.outStream.write(`\x1b[${r};1H\x1b[2K`);
      }
    }

    this.prevPanelHeight = panelHeight;
    this.prevInputHeight = inputHeight;

    // Render panel lines if any
    if (panelHeight > 0) {
      for (let i = 0; i < panelHeight; i++) {
        const row = panelStartRow + i;
        this.outStream.write(`\x1b[${row};1H\x1b[2K${this.currentPanelLines[i]}`);
      }
    }

    // Render input lines
    for (let i = 0; i < inputHeight; i++) {
      const row = inputStartRow + i;
      const isFirstLine = windowStart + i === 0;
      const promptPrefix = isFirstLine ? `${colors.bold}${colors.green}>${colors.reset} ` : '  ';
      const lineText = displayLines[i];
      const formattedText = lineText
        .replace(
          /(\[Pasted text #\d+ \+\d+ (?:lines|chars)\])/g,
          `${colors.cyan}${colors.bold}$1${colors.reset}`,
        )
        .replace(/ ↵ $/g, `${colors.dim} ↵ ${colors.reset}`);

      let content = `${promptPrefix}${formattedText}`;
      if (i === inputHeight - 1 && status) {
        content += ` ${colors.dim}[${status}]${colors.reset}`;
      }

      this.outStream.write(`\x1b[${row};1H\x1b[2K${content}`);
    }

    // Position cursor
    const cursorRowOnScreen = inputStartRow + displayCursorLine;
    this.outStream.write(`\x1b[${cursorRowOnScreen};${cursorVisualCol}H`);
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
