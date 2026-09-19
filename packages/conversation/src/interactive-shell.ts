import * as readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { TaskForgeConfig, loadConfig } from '@taskforge/shared';
import { GitService, RepositoryAnalyzer } from '@taskforge/workspace';
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
import { TelemetryCollector, PerformanceEngine } from '@taskforge/telemetry';
import { InteractionGateway } from '@taskforge/execution';
import { TuiDashboard } from './tui-dashboard.js';

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
    'criar', 'cria', 'fazer', 'faça', 'investigar', 'investiga', 'explicar', 'explique',
    'analisar', 'analise', 'porque', 'não', 'nao', 'sim', 'da', 'das', 'dos', 'em', 'na',
    'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'que', 'com', 'por', 'tarefa', 'tarefas',
    'plano', 'executar', 'execução', 'executa', 'agente', 'agentes', 'adicionar', 'adiciona',
    'retomar', 'retoma', 'pausar', 'pausa', 'descartar', 'ajuda', 'olá', 'ola', 'oi',
    'projeto', 'mostrar', 'mostra', 'quanto', 'gastei', 'quem', 'trabalhando', 'pode',
    'rodar', 'aprova', 'apenas', 'nesta', 'neste', 'mexa', 'mexer', 'escrever',
  ];

  const enWords = [
    'create', 'make', 'investigate', 'explain', 'analyze', 'why', 'how', 'yes', 'for',
    'from', 'of', 'in', 'at', 'on', 'the', 'that', 'with', 'by', 'task', 'tasks', 'plan',
    'execute', 'execution', 'agent', 'agents', 'add', 'resume', 'pause', 'discard',
    'help', 'hello', 'hi', 'what', 'is', 'are', 'can', 'you', 'please', 'run', 'build',
    'test', 'debug', 'project', 'show', 'spend', 'who', 'working', 'change', 'modify',
    'touch', 'allow', 'deny', 'current', 'files', 'file', 'should', 'would', 'could',
    'endpoint', 'health', 'code',
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
  private sessionLanguage?: ShellLanguage;
  private outStream: Writable;

  constructor(private options: ShellOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.outStream = options.output ?? process.stdout;
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

    const lines = [
      '',
      ' TaskForge',
      ` ${this.repoRoot}  •  ${gitStatus.currentBranch}  •  ${gitStatus.isClean ? 'clean' : 'modified'}`,
      '',
      ' Agents',
      ...reports.map((r) => ` ${r.name.padEnd(16)} ● ${r.ready ? 'ready' : 'not detected'}`),
      '',
      ' Router',
      ` OpenAI       ● ${this.config.router.provider === 'openai' && Boolean(process.env.OPENAI_API_KEY) ? 'ready' : 'static fallback'}`,
      '',
      ' ECC',
      ` ${profile.hasECC ? '● detected' : '○ not detected'}`,
      '────────────────────────────────────',
      '',
    ];

    return lines.join('\n');
  }

  async handleInput(input: string): Promise<string> {
    const text = input.trim();
    if (!text) return '';

    if (!text.startsWith('/')) {
      if (isPortugueseText(text)) {
        this.sessionLanguage = 'pt';
      } else if (text.length > 0) {
        this.sessionLanguage = 'en';
      }
    }

    const isEn = this.sessionLanguage === 'en';

    if (text === '/exit' || text === '/quit') {
      return isEn ? 'Session closed.' : 'Sessão encerrada.';
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
          header,
          ...tasks.map(
            (t) =>
              `  - ${t.id}: ${t.title} [${t.status.toUpperCase()}]${t.dependencies.length > 0 ? ` (${depPrefix}${t.dependencies.join(', ')})` : ''}`,
          ),
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
        const runStats = this.activeRunId ? this.telemetry.getRunSummary(this.activeRunId) : undefined;
        const costReport = this.activeRunId ? this.telemetry.getCostReport(this.activeRunId) : undefined;
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

        if (isEn) {
          return [
            `Understood. Recommended strategy: ${routing.strategy.toUpperCase()} (Complexity: ${routing.complexity}, Risk: ${routing.risk}).`,
            `Suggested team: ${selected.map((s) => `${s.agent.name} (${s.roleRequest.role})`).join(', ')}.`,
            `Total of ${tasks.length} structured tasks:`,
            ...tasks.map((t, idx) => `  ${idx + 1}. [${t.type.toUpperCase()}] ${t.title}`),
            '',
            'Do you want me to execute? (type "yes", "y" or "/approve" to start)',
          ].join('\n');
        }

        return [
          `Entendi. Estratégia recomendada: ${routing.strategy.toUpperCase()} (Complexidade: ${routing.complexity}, Risco: ${routing.risk}).`,
          `Time sugerido: ${selected.map((s) => `${s.agent.name} (${s.roleRequest.role})`).join(', ')}.`,
          `Total de ${tasks.length} tarefas estruturadas:`,
          ...tasks.map((t, idx) => `  ${idx + 1}. [${t.type.toUpperCase()}] ${t.title}`),
          '',
          'Deseja que eu execute? (digite "yes", "y" ou "/approve" para iniciar)',
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

        this.outStream.write(
          isEn
            ? '\n[TaskForge] Plan approved. Starting execution...\n'
            : '\n[TaskForge] Plano aprovado. Iniciando execução...\n',
        );

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
              onProgress: (msg) => {
                this.outStream.write(`[TaskForge] ${msg}\n`);
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

          if (isEn) {
            return [
              'Plan executed successfully!',
              `Status: ${result.status.toUpperCase()}`,
              `Tasks completed: ${result.tasksCompleted}, failed: ${result.tasksFailed}`,
              result.integrationBranch ? `Integration branch: ${result.integrationBranch}` : '',
              `Total time: ${(result.durationMs / 1000).toFixed(1)}s`,
            ]
              .filter(Boolean)
              .join('\n');
          }

          return [
            'Plano executado com sucesso!',
            `Status: ${result.status.toUpperCase()}`,
            `Tarefas concluídas: ${result.tasksCompleted}, falhas: ${result.tasksFailed}`,
            result.integrationBranch ? `Branch de integração: ${result.integrationBranch}` : '',
            `Tempo total: ${(result.durationMs / 1000).toFixed(1)}s`,
          ]
            .filter(Boolean)
            .join('\n');
        } catch (err) {
          if (isEn) {
            return `Error during plan execution: ${(err as Error).message}\n(Tip: type "yes --fake" to test with simulated agents if real agents are not configured with API keys)`;
          }
          return `Erro durante a execução do plano: ${(err as Error).message}\n(Dica: digite "yes --fake" para testar com agentes simulados caso os agentes reais não estejam configurados com chaves de API)`;
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
            'Hello! I am TaskForge, conversational control plane for autonomous coding-agent teams.',
            '',
            'To start work, simply describe your engineering objective in natural language. Examples:',
            '  > investigate why checkout charges twice',
            '  > create a JWT authentication endpoint',
            '  > refactor API routes adding input validation',
            '',
            'Quick commands:',
            '  /agents   - List available agents and readiness status',
            '  /tasks    - List active tasks',
            '  /plan     - View current task plan',
            '  /pending  - View interactions awaiting approval',
            '  /status   - Full TUI dashboard',
            '  /cost     - Token cost and telemetry report',
            '  /exit     - Exit shell',
          ].join('\n');
        }
        return [
          'Olá! Eu sou o TaskForge, control plane conversacional para equipes de agentes autônomos.',
          '',
          'Para iniciar um trabalho, basta descrever seu objetivo em linguagem natural. Exemplos:',
          '  > investiga porque o checkout cobra duas vezes',
          '  > cria um endpoint de autenticação JWT',
          '  > refatore as rotas da API adicionando validação',
          '',
          'Comandos rápidos disponíveis:',
          '  /agents   - Listar agentes disponíveis e status',
          '  /tasks    - Listar tarefas ativas',
          '  /plan     - Visualizar plano atual',
          '  /pending  - Visualizar interações aguardando aprovação',
          '  /status   - Painel TUI completo',
          '  /cost     - Relatório de custo de tokens',
          '  /exit     - Sair do shell',
        ].join('\n');
      }

      default:
        return isEn
          ? `Command received: "${text}". Type /tasks, /agents or describe an objective in natural language.`
          : `Comando recebido: "${text}". Digite /tasks, /agents ou descreva um objetivo em linguagem natural.`;
    }
  }

  async start(): Promise<void> {
    const banner = await this.renderBanner();
    const inStream = this.options.input ?? process.stdin;
    const outStream = this.options.output ?? process.stdout;

    outStream.write(banner);

    const rl = readline.createInterface({
      input: inStream,
      output: outStream,
      prompt: '> ',
    });

    let closed = false;
    rl.on('close', () => {
      closed = true;
    });

    rl.prompt();

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '/exit' || trimmed === '/quit') {
        outStream.write(this.sessionLanguage === 'en' ? 'Goodbye!\n' : 'Até logo!\n');
        break;
      }
      const reply = await this.handleInput(trimmed);
      if (reply) {
        outStream.write(`${reply}\n\n`);
      }
      if (!closed) {
        try {
          rl.prompt();
        } catch {
          closed = true;
        }
      }
    }

    if (!closed) {
      try {
        rl.close();
      } catch {
        // ignore
      }
    }
  }
}
