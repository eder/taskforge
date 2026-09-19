import * as path from 'node:path';
import * as readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { TaskForgeConfig, loadConfig } from '@taskforge/shared';
import { GitService, RepositoryAnalyzer, WorktreeManager } from '@taskforge/workspace';
import { AgentRegistry, AgentDetector } from '@taskforge/agents';
import { OperatorAgent } from '@taskforge/operator';
import { HeuristicPlanner } from '@taskforge/planner';
import { NegotiationManager } from '@taskforge/negotiation';
import {
  StaticRoutingProvider,
  OpenAIRoutingProvider,
  AdaptiveRoutingProvider,
  RoutingProvider,
  AgentSelector,
} from '@taskforge/router';
import { TaskGraph } from '@taskforge/core';
import { RunOrchestrator } from '@taskforge/scheduler';
import { TaskForgeDatabase, InteractionRepository } from '@taskforge/persistence';
import { TelemetryCollector, PerformanceEngine, TaskTokenEstimator } from '@taskforge/telemetry';
import { InteractionGateway } from '@taskforge/execution';
import { TuiDashboard } from './tui-dashboard.js';
import { theme, colors } from './theme.js';
import { TerminalViewport } from './terminal-viewport.js';
import { SlashMenu } from './slash-menu.js';

export interface ShellOptions {
  repoRoot?: string;
  config?: TaskForgeConfig;
  input?: Readable;
  output?: Writable;
  database?: TaskForgeDatabase;
}

export type ShellLanguage = 'en' | 'pt';

export function isPortugueseText(text: string): boolean {
  const lower = text.toLowerCase();
  if (/[ãõçáéíóúâêîôûà]/.test(lower)) return true;

  if (
    lower.includes('do not') ||
    lower.includes("don't") ||
    lower.includes('dont ') ||
    lower.includes('please ') ||
    lower.includes('what is') ||
    lower.includes('how to')
  ) {
    return false;
  }

  const ptWords = [
    'criar',
    'cria',
    'fazer',
    'faça',
    'investigar',
    'investiga',
    'explicar',
    'explique',
    'analisar',
    'analise',
    'porque',
    'não',
    'nao',
    'sim',
    'da',
    'das',
    'dos',
    'em',
    'na',
    'nos',
    'nas',
    'um',
    'uma',
    'uns',
    'umas',
    'que',
    'com',
    'por',
    'tarefa',
    'tarefas',
    'plano',
    'executar',
    'execução',
    'executa',
    'agente',
    'agentes',
    'adicionar',
    'adiciona',
    'retomar',
    'retoma',
    'pausar',
    'pausa',
    'descartar',
    'ajuda',
    'olá',
    'ola',
    'oi',
    'projeto',
    'mostrar',
    'mostra',
    'quanto',
    'gastei',
    'quem',
    'trabalhando',
    'pode',
    'rodar',
    'aprova',
    'apenas',
    'nesta',
    'neste',
    'mexa',
    'mexer',
    'escrever',
  ];

  const enWords = [
    'create',
    'make',
    'investigate',
    'explain',
    'analyze',
    'why',
    'how',
    'yes',
    'for',
    'from',
    'of',
    'in',
    'at',
    'on',
    'the',
    'that',
    'with',
    'by',
    'task',
    'tasks',
    'plan',
    'execute',
    'execution',
    'agent',
    'agents',
    'add',
    'resume',
    'pause',
    'discard',
    'help',
    'hello',
    'hi',
    'what',
    'is',
    'are',
    'can',
    'you',
    'please',
    'run',
    'build',
    'test',
    'debug',
    'project',
    'show',
    'spend',
    'who',
    'working',
    'change',
    'modify',
    'touch',
    'allow',
    'deny',
    'current',
    'files',
    'file',
    'should',
    'would',
    'could',
    'endpoint',
    'health',
    'code',
  ];

  let ptScore = 0;
  let enScore = 0;
  const words = lower.split(/[\s,.;:!?/()\-+"]+/);
  for (const w of words) {
    if (ptWords.includes(w)) ptScore++;
    if (enWords.includes(w)) enScore++;
  }

  if (enScore > ptScore) return false;
  if (ptScore > enScore) return true;
  return false;
}

export function findWordLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  while (i > 0 && /\s/.test(text[i])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

export function findWordRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let i = pos;
  while (i < text.length && !/\s/.test(text[i])) i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

export class InteractiveShell {
  private repoRoot: string;
  private config: TaskForgeConfig;
  private db: TaskForgeDatabase;
  private telemetry: TelemetryCollector;
  private operator: OperatorAgent;
  private agentRegistry: AgentRegistry;
  private gitService: GitService;
  private planner: HeuristicPlanner;
  private negotiator: NegotiationManager;
  private router: RoutingProvider;
  private agentSelector: AgentSelector;
  private interactionRepo: InteractionRepository;
  private interactionGateway: InteractionGateway;
  private currentGraph?: TaskGraph;
  private lastGoalDescription?: string;
  private isPaused = false;
  private activeRunId?: string;
  private sessionLanguage: ShellLanguage = 'en';
  private outStream: Writable;
  public viewport: TerminalViewport;
  public slashMenu: SlashMenu;

  constructor(private options: ShellOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.outStream = options.output ?? process.stdout;
    this.viewport = new TerminalViewport(this.outStream, {
      repoName: path.basename(this.repoRoot),
    });
    this.slashMenu = new SlashMenu(this.outStream, this.sessionLanguage);
    this.config = options.config ?? loadConfig();
    this.db = options.database ?? new TaskForgeDatabase(this.config.execution.databasePath);
    this.telemetry = new TelemetryCollector(this.db);
    this.operator = new OperatorAgent();
    this.agentRegistry = new AgentRegistry();
    this.gitService = new GitService(this.repoRoot);
    this.planner = new HeuristicPlanner();
    this.negotiator = new NegotiationManager();
    if (this.config.router.adaptive) {
      this.router = new AdaptiveRoutingProvider(new PerformanceEngine(this.db));
    } else if (this.config.router.provider === 'openai' && process.env.OPENAI_API_KEY) {
      this.router = new OpenAIRoutingProvider(process.env.OPENAI_API_KEY, this.config.router.model);
    } else {
      this.router = new StaticRoutingProvider();
    }
    this.agentSelector = new AgentSelector(this.agentRegistry);
    this.interactionRepo = new InteractionRepository(this.db);
    this.interactionGateway = new InteractionGateway({
      config: this.config,
      interactionRepo: this.interactionRepo,
    });
  }

  async renderBanner(): Promise<string> {
    const gitStatus = await this.gitService.getStatus().catch(() => ({
      currentBranch: 'unknown',
      headCommit: 'unknown',
      isClean: true,
    }));

    const analyzer = new RepositoryAnalyzer(this.repoRoot, this.gitService);
    const profile = await analyzer.analyze().catch(() => ({
      hasECC: false,
      summary: 'Repository',
      languages: [],
      frameworks: [],
      testCommands: [],
      lintCommands: [],
      typecheckCommands: [],
      buildCommands: [],
    }));

    const reports = await AgentDetector.detect(this.agentRegistry.list());
    const cleanLabel = gitStatus.isClean
      ? `${colors.green}clean${colors.reset}`
      : `${colors.yellow}modified${colors.reset}`;
    const routerStatus =
      this.config.router.provider === 'openai' && Boolean(process.env.OPENAI_API_KEY)
        ? `${colors.green}● ready${colors.reset} ${colors.dim}(OpenAI gpt-4o)${colors.reset}`
        : `${colors.gray}● static fallback${colors.reset}`;

    const lines = [
      '',
      ` ${colors.brand}╭─────────────────────────────────────────────────────────────────╮${colors.reset}`,
      ` ${colors.brand}│${colors.reset}  ${colors.brand}${colors.bold}✦ TaskForge Control Plane${colors.reset}                              ${colors.dim}v0.1.0${colors.reset}  ${colors.brand}│${colors.reset}`,
      ` ${colors.brand}│${colors.reset}  ${colors.dim}Autonomous multi-agent coordination & git-worktree engine${colors.reset}      ${colors.brand}│${colors.reset}`,
      ` ${colors.brand}╰─────────────────────────────────────────────────────────────────╯${colors.reset}`,
      '',
      `  ${colors.dim}Repository${colors.reset}  ${colors.bold}${this.repoRoot}${colors.reset}`,
      `  ${colors.dim}Git Status${colors.reset}  ${colors.yellow}${gitStatus.currentBranch}${colors.reset} ${colors.dim}(${gitStatus.headCommit.slice(0, 7)})${colors.reset} • ${cleanLabel}`,
      '',
      `  ${colors.bold}Agents${colors.reset}`,
      ...reports.map(
        (r) => `    ${theme.agentPill(r.id, r.name, r.ready, r.quotaStatus, r.quotaReason)}`,
      ),
      '',
      `  ${colors.bold}Router${colors.reset}      OpenAI       ${routerStatus}`,
      `  ${colors.bold}ECC${colors.reset}         ${profile.hasECC ? `${colors.green}● detected${colors.reset}` : `${colors.gray}○ not detected${colors.reset}`}`,
      ` ${colors.brand}─────────────────────────────────────────────────────────────────${colors.reset}`,
      '',
    ];

    return lines.join('\n');
  }

  async handleInput(input: string, abortSignal?: AbortSignal): Promise<string> {
    const text = input.trim();
    if (!text) return '';

    const nonSlashText = text.startsWith('/') ? text.replace(/^\/\w+\s*/, '') : text;
    if (nonSlashText.length > 0) {
      if (isPortugueseText(nonSlashText)) {
        this.sessionLanguage = 'pt';
      } else if (!text.startsWith('/')) {
        this.sessionLanguage = 'en';
      }
      this.slashMenu.setLanguage(this.sessionLanguage);
    }

    const isEn = this.sessionLanguage !== 'pt';

    if (text === '/exit' || text === '/quit') {
      return isEn ? 'Session closed.' : 'Sessão encerrada.';
    }

    if (text === '/clean') {
      const worktreeManager = new WorktreeManager(
        this.repoRoot,
        this.config.execution.worktreesDir,
      );
      const deletedBranches = await worktreeManager.cleanOrphanedWorktreesAndBranches();
      return isEn
        ? `Cleaned up orphaned worktrees and ${deletedBranches} temporary branch(es).`
        : `Limpeza concluída: worktrees órfãs e ${deletedBranches} branch(es) temporárias removidas.`;
    }

    const intent = this.operator.parseIntent(text);

    switch (intent.type) {
      case 'inspect_agents': {
        const reports = await AgentDetector.detect(this.agentRegistry.list());
        return this.operator.formatResponse(intent, { agents: reports }, this.sessionLanguage);
      }

      case 'inspect_tasks': {
        const tasks = this.currentGraph
          ? this.currentGraph.getAllTasks().map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
            }))
          : [];
        return this.operator.formatResponse(intent, { tasks }, this.sessionLanguage);
      }

      case 'inspect_plan': {
        if (!this.currentGraph) {
          return isEn ? 'No active plan at the moment.' : 'Nenhum plano ativo no momento.';
        }
        const tasks = this.currentGraph.getAllTasks();
        const header = isEn ? 'Current task plan:' : 'Plano atual de tarefas:';
        const depPrefix = isEn ? 'Depends on: ' : 'Depende de: ';
        return [
          `${colors.brand}✦ ${header}${colors.reset}`,
          ...tasks.map((t) => {
            const icon = theme.taskTypeIcon(t.type);
            const badge = theme.statusBadge(t.status);
            const depText =
              t.dependencies.length > 0
                ? ` ${colors.dim}(${depPrefix}${t.dependencies.join(', ')})${colors.reset}`
                : '';
            return `  ${icon} ${colors.cyan}${t.id}${colors.reset}: ${colors.bold}${t.title}${colors.reset} [${t.status.toUpperCase()}] ${badge}${depText}`;
          }),
        ].join('\n');
      }

      case 'inspect_cost': {
        if (!this.activeRunId) {
          return isEn
            ? 'No active or recent runs for cost inquiry.'
            : 'Nenhum run ativo ou recente para consulta de custos.';
        }
        return this.telemetry.formatCostReport(this.activeRunId);
      }

      case 'inspect_stats': {
        if (!this.activeRunId) {
          return isEn
            ? 'No active or recent runs for statistics inquiry.'
            : 'Nenhum run ativo ou recente para consulta de estatísticas.';
        }
        return this.telemetry.formatStatsReport(this.activeRunId);
      }

      case 'inspect_dashboard': {
        const gitStatus = await this.gitService.getStatus().catch(() => ({
          currentBranch: 'unknown',
          headCommit: 'unknown',
          isClean: true,
        }));
        const reports = await AgentDetector.detect(this.agentRegistry.list());
        const runStats = this.activeRunId
          ? this.telemetry.getRunSummary(this.activeRunId)
          : undefined;
        const costReport = this.activeRunId
          ? this.telemetry.getCostReport(this.activeRunId)
          : undefined;
        return TuiDashboard.render({
          repoRoot: this.repoRoot,
          branch: gitStatus.currentBranch,
          headCommit: gitStatus.headCommit,
          isClean: gitStatus.isClean,
          graph: this.currentGraph,
          agents: reports,
          runStats,
          costReport,
        });
      }

      case 'pause_execution': {
        this.isPaused = true;
        return this.operator.formatResponse(intent, {}, this.sessionLanguage);
      }

      case 'resume_execution': {
        this.isPaused = false;
        return this.operator.formatResponse(intent, {}, this.sessionLanguage);
      }

      case 'add_constraint': {
        return this.operator.formatResponse(intent, {}, this.sessionLanguage);
      }

      case 'cancel_and_reassign': {
        return this.operator.formatResponse(intent, {}, this.sessionLanguage);
      }

      case 'submit_goal': {
        this.activeRunId = `run-${Date.now()}`;
        this.lastGoalDescription = intent.goal;
        const goal = {
          id: `goal-${Date.now()}`,
          description: intent.goal,
          repository: this.repoRoot,
          constraints: [],
          acceptanceCriteria: [],
          createdAt: new Date(),
        };

        const proposedGraph = await this.planner.plan(goal);
        this.currentGraph = await this.negotiator.negotiateGraph(proposedGraph, this.activeRunId);

        const tasks = this.currentGraph.getAllTasks();
        const primaryTask = tasks[0];

        const routing = await this.router.route({
          task: primaryTask,
          availableAgents: this.agentRegistry.list().map((a) => a.id),
        });

        const selected = await this.agentSelector.selectAgents(routing.roles);

        const strategyUpper = routing.strategy.toUpperCase();
        const strategyColor = strategyUpper === 'PARALLEL' ? colors.cyan : colors.green;
        const teamFormatted = selected
          .map(
            (s) =>
              `${colors.bold}${s.agent.name}${colors.reset} ${colors.dim}(${s.roleRequest.role})${colors.reset}`,
          )
          .join(', ');

        const totalEstimatedTokens = tasks.reduce(
          (sum, t) => sum + TaskTokenEstimator.estimateTask(t).totalEstimatedTokens,
          0,
        );
        const tokensFormatted = totalEstimatedTokens.toLocaleString();

        const taskFormattedList = tasks.map((t, idx) => {
          const icon = theme.taskTypeIcon(t.type);
          const typeBadge = `${colors.brandLight}[${t.type.toUpperCase()}]${colors.reset}`;
          const titleStyled = `${colors.bold}${t.title}${colors.reset}`;
          const est = TaskTokenEstimator.estimateTask(t);
          const tokenTag = `${colors.dim}(~${est.totalEstimatedTokens.toLocaleString()} tokens)${colors.reset}`;
          return `  ${colors.dim}${idx + 1}.${colors.reset} ${icon} ${typeBadge} ${titleStyled} ${tokenTag}`;
        });

        if (isEn) {
          return [
            `${colors.brand}✦ Plan Proposal${colors.reset}`,
            `Understood. Recommended strategy: ${strategyColor}${colors.bold}${strategyUpper}${colors.reset} ${colors.dim}(Complexity: ${routing.complexity}, Risk: ${routing.risk})${colors.reset}.`,
            `Suggested team: ${teamFormatted}.`,
            `Estimated tokens: ~${tokensFormatted} tokens.`,
            `Total of ${tasks.length} structured tasks:`,
            ...taskFormattedList,
            '',
            `  ${colors.green}●${colors.reset} ${colors.bold}Do you want me to execute?${colors.reset} ${colors.dim}(type "yes", "y" or "/approve" to start)${colors.reset}`,
          ].join('\n');
        }

        return [
          `${colors.brand}✦ Proposta de Plano${colors.reset}`,
          `Entendi. Estratégia recomendada: ${strategyColor}${colors.bold}${strategyUpper}${colors.reset} ${colors.dim}(Complexidade: ${routing.complexity}, Risco: ${routing.risk})${colors.reset}.`,
          `Time sugerido: ${teamFormatted}.`,
          `Demanda estimada: ~${tokensFormatted} tokens.`,
          `Total de ${tasks.length} tarefas estruturadas:`,
          ...taskFormattedList,
          '',
          `  ${colors.green}●${colors.reset} ${colors.bold}Deseja que eu execute?${colors.reset} ${colors.dim}(digite "yes", "y" ou "/approve" para iniciar)${colors.reset}`,
        ].join('\n');
      }

      case 'approve_interaction': {
        const pending = this.interactionGateway.getPendingRequests();
        const target = intent.requestId
          ? pending.find((p) => p.id === intent.requestId)
          : pending[0];

        if (!target) {
          return isEn
            ? 'No pending interaction found for approval.'
            : 'Nenhuma interação pendente encontrada para aprovação.';
        }

        const scope = intent.scope ?? 'task';
        this.interactionGateway.resolve(target.id, 'allow', undefined, scope);
        return isEn
          ? `✓ allowed for ${target.taskId || target.id} (scope: ${scope})\nAgent ${target.agentId} resumed work.`
          : `✓ permitido para ${target.taskId || target.id} (escopo: ${scope})\nAgente ${target.agentId} retomou o trabalho.`;
      }

      case 'deny_interaction': {
        const pending = this.interactionGateway.getPendingRequests();
        const target = intent.requestId
          ? pending.find((p) => p.id === intent.requestId)
          : pending[0];

        if (!target) {
          return isEn
            ? 'No pending interaction found for denial.'
            : 'Nenhuma interação pendente encontrada para rejeição.';
        }

        this.interactionGateway.resolve(target.id, 'deny', intent.reason, 'once');
        return isEn
          ? `✕ Operation denied for ${target.taskId || target.id}. Agent notified.`
          : `✕ Operação negada para ${target.taskId || target.id}. Agente notificado.`;
      }

      case 'inspect_pending_interactions': {
        const pending = this.interactionGateway.getPendingRequests();
        return this.operator.formatResponse(intent, { pending }, this.sessionLanguage);
      }

      case 'approve_plan': {
        // If there's an active interaction waiting for human approval, resolve it
        const pending = this.interactionGateway.getPendingRequests();
        if (pending.length > 0) {
          const target = pending[0];
          this.interactionGateway.resolve(target.id, 'allow', undefined, 'task');
          return isEn
            ? `✓ allowed for ${target.taskId || target.id} (scope: task)\nAgent ${target.agentId} resumed work.`
            : `✓ permitido para ${target.taskId || target.id} (escopo: task)\nAgente ${target.agentId} retomou o trabalho.`;
        }

        if (!this.currentGraph) {
          return isEn
            ? 'No pending plan for approval. Describe an engineering goal in natural language to get started.'
            : 'Nenhum plano pendente de aprovação. Descreva um objetivo em linguagem natural para começar.';
        }

        const isFakeRequested = text.includes('--fake') || text.includes('fake');

        const approvedMsg = isEn
          ? `\n  ${colors.brand}✦ ${colors.bold}TaskForge Execution${colors.reset}\n  ${colors.green}✔${colors.reset} ${colors.bold}Plan approved.${colors.reset} ${colors.dim}Starting execution...${colors.reset}\n`
          : `\n  ${colors.brand}✦ ${colors.bold}Execução TaskForge${colors.reset}\n  ${colors.green}✔${colors.reset} ${colors.bold}Plano aprovado.${colors.reset} ${colors.dim}Iniciando execução...${colors.reset}\n`;
        this.viewport.writeUpper(approvedMsg);
        this.viewport.drawFooter(isEn ? '⚡ Executing plan...' : '⚡ Executando plano...');

        const orchestrator = new RunOrchestrator({
          repoRoot: this.repoRoot,
          config: this.config,
          database: this.db,
          agentRegistry: this.agentRegistry,
          planner: this.planner,
          negotiator: this.negotiator,
          router: this.router,
          agentSelector: this.agentSelector,
          gitService: this.gitService,
          interactionGateway: this.interactionGateway,
        });

        try {
          const result = await orchestrator.run(
            this.lastGoalDescription ?? (isEn ? 'Approved execution' : 'Execução aprovada'),
            {
              preplannedGraph: this.currentGraph,
              fakeFallback: isFakeRequested,
              abortSignal,
              onProgress: (msg) => {
                this.viewport.writeUpper(theme.formatProgressMessage(msg));
              },
            },
          );
          this.activeRunId = result.runId;
          this.currentGraph = undefined;

          this.telemetry.recordRunMetrics({
            runId: result.runId,
            durationMs: result.durationMs,
            tasksCount: result.tasksCompleted + result.tasksFailed,
            tasksCompleted: result.tasksCompleted,
            tasksFailed: result.tasksFailed,
            reworkCount: 0,
            escalationsCount: 0,
          });

          const statusColor =
            result.status === 'completed'
              ? colors.green
              : result.status === 'cancelled'
                ? colors.yellow
                : colors.red;

          const outputs = Object.entries(result.taskOutputs ?? {})
            .filter(([, text]) => text && text.trim().length > 0)
            .map(([taskId, text]) => {
              const header = isEn
                ? `Explanation & Analysis [${taskId}]`
                : `Explicação & Análise [${taskId}]`;
              const highlighted = theme.renderMarkdown(text.trim());
              const divider = `${colors.darkGray}${'─'.repeat(64)}${colors.reset}`;
              return `  ${colors.brand}✦ ${colors.bold}${header}${colors.reset}\n  ${divider}\n${highlighted}\n  ${divider}\n`;
            })
            .join('\n\n');

          const outputPrefix = outputs ? `${outputs}\n` : '';

          const isSuccess = result.status === 'completed';
          const isCancelled = result.status === 'cancelled';
          const title = isSuccess
            ? isEn
              ? 'Plan executed successfully!'
              : 'Plano executado com sucesso!'
            : isCancelled
              ? isEn
                ? 'Plan execution cancelled by user'
                : 'Execução cancelada pelo usuário'
              : isEn
                ? 'Plan execution encountered issues'
                : 'Execução do plano finalizada com pendências';
          const titleIcon = isSuccess
            ? `${colors.green}✔${colors.reset}`
            : isCancelled
              ? `${colors.yellow}⊘${colors.reset}`
              : `${colors.red}✖${colors.reset}`;

          const divider = `${colors.darkGray}${'─'.repeat(64)}${colors.reset}`;

          if (isEn) {
            return [
              outputPrefix,
              `  ${colors.brand}✦ ${colors.bold}Run Summary${colors.reset}`,
              `  ${divider}`,
              `  ${titleIcon} ${colors.bold}${title}${colors.reset}`,
              '',
              `    ${colors.dim}Status:${colors.reset}             ${statusColor}${colors.bold}${result.status.toUpperCase()}${colors.reset}`,
              `    ${colors.dim}Tasks completed:${colors.reset}    ${colors.bold}${result.tasksCompleted}${colors.reset}, failed: ${result.tasksFailed}`,
              result.integrationBranch
                ? `    ${colors.dim}Integration branch:${colors.reset} ${colors.cyan}${result.integrationBranch}${colors.reset}`
                : '',
              result.error
                ? `    ${colors.dim}Error:${colors.reset}              ${colors.red}${result.error}${colors.reset}`
                : '',
              `    ${colors.dim}Total time:${colors.reset}         ${colors.yellow}${(result.durationMs / 1000).toFixed(1)}s${colors.reset}`,
              `  ${divider}`,
            ]
              .filter(Boolean)
              .join('\n');
          }

          return [
            outputPrefix,
            `  ${colors.brand}✦ ${colors.bold}Resumo da Execução${colors.reset}`,
            `  ${divider}`,
            `  ${titleIcon} ${colors.bold}${title}${colors.reset}`,
            '',
            `    ${colors.dim}Status:${colors.reset}             ${statusColor}${colors.bold}${result.status.toUpperCase()}${colors.reset}`,
            `    ${colors.dim}Tarefas concluídas:${colors.reset} ${colors.bold}${result.tasksCompleted}${colors.reset}, falhas: ${result.tasksFailed}`,
            result.integrationBranch
              ? `    ${colors.dim}Branch de integração:${colors.reset} ${colors.cyan}${result.integrationBranch}${colors.reset}`
              : '',
            result.error
              ? `    ${colors.dim}Erro:${colors.reset}               ${colors.red}${result.error}${colors.reset}`
              : '',
            `    ${colors.dim}Tempo total:${colors.reset}        ${colors.yellow}${(result.durationMs / 1000).toFixed(1)}s${colors.reset}`,
            `  ${divider}`,
          ]
            .filter(Boolean)
            .join('\n');
        } catch (err) {
          if (isEn) {
            return `${colors.red}✕ Error during plan execution: ${(err as Error).message}${colors.reset}\n${colors.dim}(Tip: type "yes --fake" to test with simulated agents if real agents are not configured with API keys)${colors.reset}`;
          }
          return `${colors.red}✕ Erro durante a execução do plano: ${(err as Error).message}${colors.reset}\n${colors.dim}(Dica: digite "yes --fake" para testar com agentes simulados caso os agentes reais não estejam configurados com chaves de API)${colors.reset}`;
        }
      }

      case 'reject_plan': {
        const pending = this.interactionGateway.getPendingRequests();
        if (pending.length > 0) {
          const target = pending[0];
          this.interactionGateway.resolve(target.id, 'deny', intent.feedback, 'once');
          return isEn
            ? `✕ Operation denied for ${target.taskId || target.id}. Agent notified.`
            : `✕ Operação negada para ${target.taskId || target.id}. Agente notificado.`;
        }
        this.currentGraph = undefined;
        this.lastGoalDescription = undefined;
        return isEn ? 'Plan discarded as requested.' : 'Plano descartado conforme solicitado.';
      }

      case 'general_query': {
        if (isEn) {
          return [
            `  ${colors.brand}✦ ${colors.bold}TaskForge Control Plane${colors.reset}`,
            `  ${colors.dim}Conversational control plane for autonomous coding-agent teams (Claude, Codex, Antigravity).${colors.reset}`,
            '',
            `  ${colors.bold}To start work, describe your engineering objective:${colors.reset}`,
            `    ${colors.cyan}›${colors.reset} investigate why checkout charges twice`,
            `    ${colors.cyan}›${colors.reset} create a JWT authentication endpoint`,
            `    ${colors.cyan}›${colors.reset} refactor API routes adding input validation`,
            '',
            `  ${colors.bold}Quick Commands:${colors.reset}`,
            `    ${colors.brand}/agents${colors.reset}   List available agent harnesses and status`,
            `    ${colors.brand}/tasks${colors.reset}    List active tasks in this run`,
            `    ${colors.brand}/plan${colors.reset}     View current task plan`,
            `    ${colors.brand}/pending${colors.reset}  View interactions awaiting approval`,
            `    ${colors.brand}/status${colors.reset}   Full TUI dashboard`,
            `    ${colors.brand}/cost${colors.reset}     Token cost and telemetry report`,
            `    ${colors.brand}/clean${colors.reset}    Clean temporary worktrees and branches`,
            `    ${colors.brand}/exit${colors.reset}     Exit session`,
          ].join('\n');
        }
        return [
          `  ${colors.brand}✦ ${colors.bold}TaskForge Control Plane${colors.reset}`,
          `  ${colors.dim}Control plane conversacional para equipes de agentes autônomos (Claude, Codex, Antigravity).${colors.reset}`,
          '',
          `  ${colors.bold}Para iniciar um trabalho, descreva seu objetivo em linguagem natural:${colors.reset}`,
          `    ${colors.cyan}›${colors.reset} investiga porque o checkout cobra duas vezes`,
          `    ${colors.cyan}›${colors.reset} cria um endpoint de autenticação JWT`,
          `    ${colors.cyan}›${colors.reset} refatore as rotas da API adicionando validação`,
          '',
          `  ${colors.bold}Comandos rápidos disponíveis:${colors.reset}`,
          `    ${colors.brand}/agents${colors.reset}   Listar agentes disponíveis e status`,
          `    ${colors.brand}/tasks${colors.reset}    Listar tarefas ativas`,
          `    ${colors.brand}/plan${colors.reset}     Visualizar plano atual`,
          `    ${colors.brand}/pending${colors.reset}  Visualizar interações aguardando aprovação`,
          `    ${colors.brand}/status${colors.reset}   Painel TUI completo`,
          `    ${colors.brand}/cost${colors.reset}     Relatório de custo e tokens`,
          `    ${colors.brand}/clean${colors.reset}    Limpar worktrees e branches temporárias`,
          `    ${colors.brand}/exit${colors.reset}     Sair da sessão`,
        ].join('\n');
      }

      default:
        return isEn
          ? `Command received: "${text}". Type /tasks, /agents or describe an objective in natural language.`
          : `Comando recebido: "${text}". Digite /tasks, /agents ou descreva um objetivo em linguagem natural.`;
    }
  }

  async start(): Promise<void> {
    const worktreeManager = new WorktreeManager(this.repoRoot);
    await worktreeManager.cleanOrphanedWorktreesAndBranches().catch(() => {});

    const gitStatus = await this.gitService.getStatus().catch(() => ({
      currentBranch: 'main',
    }));
    const repoName = path.basename(this.repoRoot);
    this.viewport.updateContext(repoName, gitStatus.currentBranch);

    const banner = await this.renderBanner();
    const inStream = this.options.input ?? process.stdin;
    const outStream = this.options.output ?? process.stdout;

    // Non-interactive fallback (tests, pipes, CI)
    if (!this.viewport.isInteractive) {
      this.viewport.writeUpper(banner);
      const rl = readline.createInterface({
        input: inStream,
        output: outStream,
        terminal: false,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed === '/exit' || trimmed === '/quit') break;
        if (!trimmed) continue;
        const reply = await this.handleInput(trimmed);
        if (reply) {
          outStream.write(`${reply}\n`);
        }
      }
      try {
        this.db.close();
      } catch {}
      return;
    }

    // Interactive Terminal REPL with persistent bottom line starting with `> `
    this.viewport.init();
    this.viewport.writeUpper(banner);

    const inStreamAny = inStream as unknown as {
      setRawMode?: (mode: boolean) => void;
      resume?: () => void;
      pause?: () => void;
    };
    if (typeof inStreamAny.setRawMode === 'function') {
      try {
        inStreamAny.setRawMode(true);
      } catch {}
    }
    inStreamAny.resume?.();

    readline.emitKeypressEvents(inStream);

    let buffer = '';
    let cursorIndex = 0;
    const history: string[] = [];
    let historyIndex = -1;
    let savedInput = '';
    let isRunning = false;
    let activeAbortController: AbortController | undefined;
    let closed = false;
    let pendingResolve: ((line: string | null) => void) | null = null;

    const readNextLine = (): Promise<string | null> => {
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      process.removeListener('SIGINT', cleanup);
      process.removeListener('exit', cleanup);
      this.slashMenu.close();
      this.viewport.cleanup();
      inStream.removeListener('keypress', onKeypress);
      if (typeof inStreamAny.setRawMode === 'function') {
        try {
          inStreamAny.setRawMode(false);
        } catch {}
      }
      try {
        inStreamAny.pause?.();
      } catch {}
      try {
        this.db.close();
      } catch {}
      worktreeManager.cleanOrphanedWorktreesAndBranches().catch(() => {});
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined) => {
      if (closed) return;

      // Ctrl+C: Cancel current running operation or exit safely
      if (key?.ctrl && key?.name === 'c') {
        if (isRunning && activeAbortController) {
          activeAbortController.abort();
          this.viewport.writeUpper(
            `\n${colors.red}^C ${this.sessionLanguage === 'en' ? 'Operation cancelled by user.' : 'Operação cancelada pelo usuário.'}${colors.reset}\n`,
          );
          buffer = '';
          cursorIndex = 0;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          return;
        }

        if (buffer.length > 0) {
          buffer = '';
          cursorIndex = 0;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          return;
        }

        const exitMsg =
          this.sessionLanguage === 'en'
            ? `\n${colors.brand}✦${colors.reset} Goodbye!\n`
            : `\n${colors.brand}✦${colors.reset} Até logo!\n`;
        this.viewport.writeUpper(exitMsg);
        cleanup();
        const res = pendingResolve;
        pendingResolve = null;
        res?.(null);
        if (!this.options.input) {
          process.exit(0);
        }
        return;
      }

      // Ctrl+D: Exit CLI when input is empty; delete char under cursor if not empty
      if (key?.ctrl && key?.name === 'd') {
        if (buffer.length === 0) {
          const exitMsg =
            this.sessionLanguage === 'en'
              ? `\n${colors.brand}✦${colors.reset} Goodbye!\n`
              : `\n${colors.brand}✦${colors.reset} Até logo!\n`;
          this.viewport.writeUpper(exitMsg);
          cleanup();
          const res = pendingResolve;
          pendingResolve = null;
          res?.(null);
          if (!this.options.input) {
            process.exit(0);
          }
          return;
        }

        if (cursorIndex < buffer.length) {
          buffer = buffer.slice(0, cursorIndex) + buffer.slice(cursorIndex + 1);
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          if (buffer.startsWith('/')) {
            this.slashMenu.update(buffer, false);
          } else {
            this.slashMenu.close();
          }
        }
        return;
      }

      // If an operation is actively running, ignore other key entries (except Ctrl+C above)
      if (isRunning) {
        return;
      }

      // Return / Enter: submit line
      if (key?.name === 'return' || key?.name === 'enter') {
        if (this.slashMenu.isOpen) {
          const selected = this.slashMenu.getSelected();
          if (selected && (buffer === '/' || !buffer.includes(' '))) {
            buffer = selected.cmd;
          }
          this.slashMenu.close();
        }

        const submitted = buffer;
        buffer = '';
        cursorIndex = 0;
        historyIndex = -1;
        savedInput = '';

        if (submitted.trim()) {
          history.push(submitted);
        }

        // Echo user prompt into the upper scrolling history
        this.viewport.writeUpper(`${colors.bold}${colors.green}>${colors.reset} ${submitted}`);

        const res = pendingResolve;
        pendingResolve = null;
        res?.(submitted);
        return;
      }

      // Slash menu navigation with Up / Down / Tab / Esc
      if (this.slashMenu.isOpen && key) {
        if (key.name === 'up') {
          this.slashMenu.selectPrev();
          return;
        }
        if (key.name === 'down') {
          this.slashMenu.selectNext();
          return;
        }
        if (key.name === 'tab') {
          const selected = this.slashMenu.getSelected();
          if (selected) {
            buffer = selected.cmd;
            cursorIndex = buffer.length;
            this.slashMenu.update(buffer);
            this.viewport.renderInputLine(buffer, cursorIndex, '');
          }
          return;
        }
        if (key.name === 'escape') {
          this.slashMenu.close();
          return;
        }
      }

      // Backspace
      if (key?.name === 'backspace') {
        if (cursorIndex > 0) {
          buffer = buffer.slice(0, cursorIndex - 1) + buffer.slice(cursorIndex);
          cursorIndex--;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          if (buffer.startsWith('/')) {
            this.slashMenu.update(buffer, true);
          } else {
            this.slashMenu.close();
          }
        }
        return;
      }

      // Delete key
      if (key?.name === 'delete') {
        if (cursorIndex < buffer.length) {
          buffer = buffer.slice(0, cursorIndex) + buffer.slice(cursorIndex + 1);
          this.viewport.renderInputLine(buffer, cursorIndex, '');
          if (buffer.startsWith('/')) {
            this.slashMenu.update(buffer, false);
          } else {
            this.slashMenu.close();
          }
        }
        return;
      }

      // Left arrow (with word jump support)
      if (key?.name === 'left') {
        if (key.meta || key.ctrl) {
          cursorIndex = findWordLeft(buffer, cursorIndex);
        } else if (cursorIndex > 0) {
          cursorIndex--;
        }
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // Right arrow (with word jump support)
      if (key?.name === 'right') {
        if (key.meta || key.ctrl) {
          cursorIndex = findWordRight(buffer, cursorIndex);
        } else if (cursorIndex < buffer.length) {
          cursorIndex++;
        }
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // Home / Ctrl+A
      if (key?.name === 'home' || (key?.ctrl && key?.name === 'a')) {
        cursorIndex = 0;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // End / Ctrl+E
      if (key?.name === 'end' || (key?.ctrl && key?.name === 'e')) {
        cursorIndex = buffer.length;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        return;
      }

      // Ctrl+U (delete to start of line)
      if (key?.ctrl && key?.name === 'u') {
        buffer = buffer.slice(cursorIndex);
        cursorIndex = 0;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        if (!buffer.startsWith('/')) this.slashMenu.close();
        return;
      }

      // Ctrl+K (delete to end of line)
      if (key?.ctrl && key?.name === 'k') {
        buffer = buffer.slice(0, cursorIndex);
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        if (!buffer.startsWith('/')) this.slashMenu.close();
        return;
      }

      // Ctrl+W (delete previous word)
      if (key?.ctrl && key?.name === 'w') {
        const newIdx = findWordLeft(buffer, cursorIndex);
        buffer = buffer.slice(0, newIdx) + buffer.slice(cursorIndex);
        cursorIndex = newIdx;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
        if (!buffer.startsWith('/')) this.slashMenu.close();
        return;
      }

      // Up arrow: Command history previous
      if (key?.name === 'up') {
        if (history.length > 0) {
          if (historyIndex === -1) {
            savedInput = buffer;
            historyIndex = history.length - 1;
          } else if (historyIndex > 0) {
            historyIndex--;
          }
          buffer = history[historyIndex];
          cursorIndex = buffer.length;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
        }
        return;
      }

      // Down arrow: Command history next
      if (key?.name === 'down') {
        if (historyIndex !== -1) {
          if (historyIndex < history.length - 1) {
            historyIndex++;
            buffer = history[historyIndex];
          } else {
            historyIndex = -1;
            buffer = savedInput;
          }
          cursorIndex = buffer.length;
          this.viewport.renderInputLine(buffer, cursorIndex, '');
        }
        return;
      }

      // Printable character entry
      if (str && !key?.ctrl && !key?.meta) {
        buffer = buffer.slice(0, cursorIndex) + str + buffer.slice(cursorIndex);
        cursorIndex += str.length;

        if (buffer.startsWith('/')) {
          const updateRes = this.slashMenu.update(buffer, false);
          if (updateRes.autoCompleted) {
            buffer = updateRes.autoCompleted;
            cursorIndex = buffer.length;
            this.slashMenu.update(buffer, false);
          }
        } else {
          this.slashMenu.close();
        }

        this.viewport.renderInputLine(buffer, cursorIndex, '');
      }
    };

    inStream.on('keypress', onKeypress);

    process.on('SIGINT', cleanup);
    process.on('exit', cleanup);

    while (!closed) {
      this.viewport.renderInputLine(buffer, cursorIndex, '');
      const line = await readNextLine();
      if (line === null) break;

      const trimmed = line.trim();
      if (trimmed === '/exit' || trimmed === '/quit') {
        const exitMsg =
          this.sessionLanguage === 'en'
            ? `\n${colors.brand}✦${colors.reset} Goodbye!\n`
            : `\n${colors.brand}✦${colors.reset} Até logo!\n`;
        this.viewport.writeUpper(exitMsg);
        cleanup();
        if (!this.options.input) {
          process.exit(0);
        }
        break;
      }

      if (!trimmed) {
        continue;
      }

      isRunning = true;
      activeAbortController = new AbortController();
      this.viewport.renderInputLine(
        '',
        0,
        this.sessionLanguage === 'en' ? 'Thinking...' : 'Processando...',
      );

      try {
        const reply = await this.handleInput(trimmed, activeAbortController.signal);
        if (reply) {
          this.viewport.writeUpper(`\n${reply}\n`);
        }
      } catch (err: any) {
        if (!activeAbortController.signal.aborted) {
          this.viewport.writeUpper(`\n${colors.red}Error: ${err?.message || err}${colors.reset}\n`);
        }
      } finally {
        isRunning = false;
        activeAbortController = undefined;
        this.viewport.renderInputLine(buffer, cursorIndex, '');
      }
    }

    cleanup();
    if (!this.options.input) {
      process.exit(0);
    }
  }
}
