import type { Writable } from 'node:stream';
import { colors } from './theme.js';

export interface SlashCommandItem {
  cmd: string;
  descEn: string;
  descPt: string;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  { cmd: '/exit', descEn: 'Exit interactive session', descPt: 'Sair da sessão interativa' },
  { cmd: '/help', descEn: 'Display command reference and guide', descPt: 'Exibir comandos disponíveis e ajuda' },
  { cmd: '/plan', descEn: 'Inspect current proposed or active plan', descPt: 'Ver plano atual proposto ou ativo' },
  { cmd: '/tasks', descEn: 'List status of all tasks in current run', descPt: 'Listar tarefas da execução atual' },
  { cmd: '/status', descEn: 'Open full TUI dashboard', descPt: 'Abrir painel TUI completo' },
  { cmd: '/agents', descEn: 'Inspect detected AI agent harnesses', descPt: 'Inspecionar agentes de IA detectados' },
  { cmd: '/cost', descEn: 'Show tokens and financial cost report', descPt: 'Exibir relatório de tokens e custos' },
  { cmd: '/stats', descEn: 'Show run execution metrics', descPt: 'Exibir métricas da execução' },
  { cmd: '/clean', descEn: 'Clean temporary worktrees and branches', descPt: 'Limpar worktrees e branches temporárias' },
  { cmd: '/pending', descEn: 'View interactions awaiting approval', descPt: 'Ver interações aguardando aprovação' },
  { cmd: '/approve', descEn: 'Approve plan or pending interaction', descPt: 'Aprovar plano ou interação pendente' },
  { cmd: '/deny', descEn: 'Deny pending interaction', descPt: 'Recusar interação pendente' },
  { cmd: '/reject', descEn: 'Reject current plan with feedback', descPt: 'Rejeitar plano atual com feedback' },
  { cmd: '/reassign', descEn: 'Reassign task to another agent', descPt: 'Reatribuir tarefa para outro agente' },
  { cmd: '/pause', descEn: 'Pause orchestrator execution', descPt: 'Pausar execução do orquestrador' },
  { cmd: '/resume', descEn: 'Resume paused execution', descPt: 'Retomar execução pausada' },
];

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
    private language: 'en' | 'pt' = 'en',
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

  public setLanguage(lang: 'en' | 'pt') {
    this.language = lang;
    if (this.isOpen) {
      this.render();
    }
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
    if (!isBackspace && this.matches.length === 1 && line.length > 1 && line !== this.matches[0].cmd) {
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
    const title = this.language === 'en' ? '✦ Commands' : '✦ Comandos';
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
      const desc = this.language === 'en' ? item.descEn : item.descPt;

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
    const hint =
      this.language === 'en'
        ? '↑/↓ browse • Tab complete • Esc close'
        : '↑/↓ navegar • Tab autocompletar • Esc fechar';
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
