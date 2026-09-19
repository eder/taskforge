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

  constructor(private options: ShellOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
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
      ...reports.map((r) => ` ${r.name.padEnd(12)} ● ${r.ready ? 'ready' : 'not detected'}`),
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

    if (text === '/exit' || text === '/quit') {
      return 'Sessão encerrada.';
    }

    const intent = this.operator.parseIntent(text);

    switch (intent.type) {
      case 'inspect_agents': {
        const reports = await AgentDetector.detect(this.agentRegistry.list());
        return this.operator.formatResponse(intent, { agents: reports });
      }

      case 'inspect_tasks': {
        const tasks = this.currentGraph
          ? this.currentGraph.getAllTasks().map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
            }))
          : [];
        return this.operator.formatResponse(intent, { tasks });
      }

      case 'inspect_plan': {
        if (!this.currentGraph) return 'Nenhum plano ativo no momento.';
        const tasks = this.currentGraph.getAllTasks();
        return [
          'Plano atual de tarefas:',
          ...tasks.map(
            (t) =>
              `  - ${t.id}: ${t.title} [${t.status.toUpperCase()}]${t.dependencies.length > 0 ? ` (Depende de: ${t.dependencies.join(', ')})` : ''}`,
          ),
        ].join('\n');
      }

      case 'inspect_cost': {
        if (!this.activeRunId) {
          return 'Nenhum run ativo ou recente para consulta de custos.';
        }
        return this.telemetry.formatCostReport(this.activeRunId);
      }

      case 'inspect_stats': {
        if (!this.activeRunId) {
          return 'Nenhum run ativo ou recente para consulta de estatísticas.';
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
        return this.operator.formatResponse(intent, {});
      }

      case 'resume_execution': {
        this.isPaused = false;
        return this.operator.formatResponse(intent, {});
      }

      case 'add_constraint': {
        return this.operator.formatResponse(intent, {});
      }

      case 'cancel_and_reassign': {
        return this.operator.formatResponse(intent, {});
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

        return [
          `Entendi. Estratégia recomendada: ${routing.strategy.toUpperCase()} (Complexidade: ${routing.complexity}, Risco: ${routing.risk}).`,
          `Time sugerido: ${selected.map((s) => `${s.agent.name} (${s.roleRequest.role})`).join(', ')}.`,
          `Total de ${tasks.length} tarefas estruturadas:`,
          ...tasks.map((t, idx) => `  ${idx + 1}. [${t.type.toUpperCase()}] ${t.title}`),
          '',
          'Deseja que eu execute? (digite "sim" ou "/approve" para iniciar)',
        ].join('\n');
      }

      case 'approve_interaction': {
        const pending = this.interactionGateway.getPendingRequests();
        const target = intent.requestId
          ? pending.find((p) => p.id === intent.requestId)
          : pending[0];

        if (!target) {
          return 'Nenhuma interação pendente encontrada para aprovação.';
        }

        const scope = intent.scope ?? 'task';
        this.interactionGateway.resolve(target.id, 'allow', undefined, scope);
        return `✓ permitido para ${target.taskId || target.id} (escopo: ${scope})\nAgente ${target.agentId} retomou o trabalho.`;
      }

      case 'deny_interaction': {
        const pending = this.interactionGateway.getPendingRequests();
        const target = intent.requestId
          ? pending.find((p) => p.id === intent.requestId)
          : pending[0];

        if (!target) {
          return 'Nenhuma interação pendente encontrada para rejeição.';
        }

        this.interactionGateway.resolve(target.id, 'deny', intent.reason, 'once');
        return `✕ Operação negada para ${target.taskId || target.id}. Agente notificado.`;
      }

      case 'inspect_pending_interactions': {
        const pending = this.interactionGateway.getPendingRequests();
        return this.operator.formatResponse(intent, { pending });
      }

      case 'approve_plan': {
        // If there's an active interaction waiting for human approval, resolve it
        const pending = this.interactionGateway.getPendingRequests();
        if (pending.length > 0) {
          const target = pending[0];
          this.interactionGateway.resolve(target.id, 'allow', undefined, 'task');
          return `✓ permitido para ${target.taskId || target.id} (escopo: task)\nAgente ${target.agentId} retomou o trabalho.`;
        }

        if (!this.currentGraph) {
          return 'Nenhum plano pendente de aprovação. Descreva um objetivo em linguagem natural para começar.';
        }

        const isFakeRequested = text.includes('--fake') || text.includes('fake');

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
          const result = await orchestrator.run(this.lastGoalDescription ?? 'Execução aprovada', {
            preplannedGraph: this.currentGraph,
            fakeFallback: isFakeRequested,
          });
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
          return `Erro durante a execução do plano: ${(err as Error).message}\n(Dica: digite "sim --fake" para testar com agentes simulados caso os agentes reais não estejam configurados com chaves de API)`;
        }
      }

      case 'reject_plan': {
        this.currentGraph = undefined;
        this.lastGoalDescription = undefined;
        return 'Plano descartado conforme solicitado.';
      }

      case 'general_query': {
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
        return `Comando recebido: "${text}". Digite /tasks, /agents ou descreva um objetivo em linguagem natural.`;
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
        outStream.write('Até logo!\n');
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
