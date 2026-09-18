export type OperatorIntent =
  | { type: 'inspect_tasks'; taskId?: string }
  | { type: 'inspect_agents' }
  | { type: 'inspect_plan' }
  | { type: 'inspect_cost' }
  | { type: 'pause_execution' }
  | { type: 'resume_execution' }
  | {
      type: 'cancel_and_reassign';
      taskId: string;
      fromAgent: string;
      preferredReplacement: string;
      targetAgentId?: string;
    }
  | { type: 'add_constraint'; constraint: string; readOnlyScope?: string }
  | { type: 'approve_plan' }
  | { type: 'reject_plan'; feedback?: string }
  | { type: 'submit_goal'; goal: string }
  | { type: 'general_query'; query: string };

export class OperatorIntentParser {
  public static parse(input: string): OperatorIntent {
    const text = input.trim();
    const lower = text.toLowerCase();

    // 1. Slash commands shortcuts
    if (text.startsWith('/tasks')) {
      const parts = text.split(/\s+/);
      return { type: 'inspect_tasks', taskId: parts[1] };
    }
    if (text.startsWith('/task ')) {
      const parts = text.split(/\s+/);
      return { type: 'inspect_tasks', taskId: parts[1] };
    }
    if (text.startsWith('/agents')) return { type: 'inspect_agents' };
    if (text.startsWith('/plan')) return { type: 'inspect_plan' };
    if (text.startsWith('/cost')) return { type: 'inspect_cost' };
    if (text.startsWith('/pause')) return { type: 'pause_execution' };
    if (text.startsWith('/resume')) return { type: 'resume_execution' };
    if (text.startsWith('/approve')) return { type: 'approve_plan' };
    if (text.startsWith('/reject')) return { type: 'reject_plan', feedback: text.replace('/reject', '').trim() };

    if (text.startsWith('/reassign')) {
      const parts = text.split(/\s+/);
      return {
        type: 'cancel_and_reassign',
        taskId: parts[1] ?? 'CURRENT',
        fromAgent: 'current',
        preferredReplacement: parts[2] ?? 'auto',
        targetAgentId: parts[2],
      };
    }

    if (text.startsWith('/constraint')) {
      return {
        type: 'add_constraint',
        constraint: text.replace('/constraint', '').trim(),
      };
    }

    // 2. Natural language equivalents for commands
    if (
      lower.includes('o que está acontecendo') ||
      lower.includes('quais as tasks') ||
      lower.includes('status das tasks') ||
      lower.includes('como estão as tasks') ||
      lower.includes('tarefas') ||
      lower.includes('list tasks') ||
      lower.includes('show tasks')
    ) {
      return { type: 'inspect_tasks' };
    }

    if (lower.includes('quem está mexendo') || lower.includes('quem está trabalhando')) {
      const taskMatch = text.match(/(TASK-\d+)/i);
      return { type: 'inspect_tasks', taskId: taskMatch ? taskMatch[1].toUpperCase() : undefined };
    }

    if (
      lower.includes('quem está disponível') ||
      lower.includes('quais agentes') ||
      lower.includes('agentes prontos') ||
      lower.includes('available agents') ||
      lower.includes('show agents') ||
      lower.includes('list agents')
    ) {
      return { type: 'inspect_agents' };
    }

    if (lower.includes('mostra o plano') || lower.includes('qual o plano') || lower.includes('ver plano')) {
      return { type: 'inspect_plan' };
    }

    if (lower.includes('quanto gastei') || lower.includes('custo') || lower.includes('tokens')) {
      return { type: 'inspect_cost' };
    }

    if (
      lower.includes('para a execução') ||
      lower.includes('pausa a execução') ||
      lower.includes('pausar') ||
      lower.includes('interrompe por enquanto')
    ) {
      return { type: 'pause_execution' };
    }

    if (lower.includes('continua') || lower.includes('retoma') || lower.includes('resume')) {
      return { type: 'resume_execution' };
    }

    if (lower.includes('sim,') || lower.includes('pode executar') || lower.includes('aprova') || lower === 'sim') {
      return { type: 'approve_plan' };
    }

    if (lower.includes('não,') || lower.includes('cancela o plano') || lower.includes('refaz')) {
      return { type: 'reject_plan', feedback: text };
    }

    // Cancel and reassign (Spec Section 5.1 example)
    if (lower.includes('reatribua') || lower.includes('reatribuir') || lower.includes('reassign')) {
      const taskMatch = text.match(/(TASK-\d+)/i);
      const agentMatch = text.match(/para\s+([\w-]+)/i);
      return {
        type: 'cancel_and_reassign',
        fromAgent: 'current',
        preferredReplacement: agentMatch ? agentMatch[1] : 'auto',
        taskId: taskMatch ? taskMatch[1].toUpperCase() : 'CURRENT',
      };
    }

    const reassignMatch = text.match(/para o (\w+) e deixa o (\w+) terminar/i);
    if (reassignMatch) {
      const taskMatch = text.match(/(TASK-\d+)/i);
      return {
        type: 'cancel_and_reassign',
        fromAgent: reassignMatch[1].toLowerCase(),
        preferredReplacement: reassignMatch[2].toLowerCase(),
        taskId: taskMatch ? taskMatch[1].toUpperCase() : 'CURRENT',
      };
    }

    // Scope and constraint patterns
    if (
      lower.startsWith('não altere') ||
      lower.startsWith('não modifique') ||
      lower.startsWith('não mexa') ||
      lower.includes('não altere') ||
      lower.includes('não modifique')
    ) {
      return {
        type: 'add_constraint',
        constraint: text,
      };
    }

    // Read-only scope restriction (Spec Section 4.3 example)
    const scopeMatch = text.match(/não deixa ninguém (escrever|mexer) em ([\w\-./*]+)/i);
    if (scopeMatch) {
      return {
        type: 'add_constraint',
        constraint: `read_only:${scopeMatch[2]}`,
        readOnlyScope: scopeMatch[2],
      };
    }

    const constraintMatch = text.match(/sem dependência nova/i);
    if (constraintMatch) {
      return {
        type: 'add_constraint',
        constraint: 'no_new_dependencies',
      };
    }

    // New goal submission
    if (
      lower.startsWith('cria ') ||
      lower.startsWith('crie ') ||
      lower.startsWith('criar ') ||
      lower.startsWith('implementa ') ||
      lower.startsWith('implemente ') ||
      lower.startsWith('implementar ') ||
      lower.startsWith('corrige ') ||
      lower.startsWith('corrija ') ||
      lower.startsWith('corrigir ') ||
      lower.startsWith('investiga ') ||
      lower.startsWith('investigue ') ||
      lower.startsWith('investigar ') ||
      lower.startsWith('faz ') ||
      lower.startsWith('faça ') ||
      lower.startsWith('fazer ') ||
      lower.startsWith('create ') ||
      lower.startsWith('add ') ||
      lower.startsWith('fix ') ||
      lower.startsWith('build ')
    ) {
      return { type: 'submit_goal', goal: text };
    }

    return { type: 'general_query', query: text };
  }
}

export class OperatorAgent {
  public parseIntent(input: string): OperatorIntent {
    return OperatorIntentParser.parse(input);
  }

  public formatResponse(intent: OperatorIntent, state: Record<string, unknown>): string {
    switch (intent.type) {
      case 'inspect_tasks': {
        const tasks = (state.tasks as Array<{ id: string; title: string; status: string; agent?: string }>) || [];
        if (tasks.length === 0) return 'Nenhuma tarefa em execução no momento.';
        return [
          'Tarefas do run:',
          ...tasks.map(
            (t) => `  ● ${t.id}: ${t.title} [${t.status.toUpperCase()}]${t.agent ? ` (Agente: ${t.agent})` : ''}`,
          ),
        ].join('\n');
      }

      case 'inspect_agents': {
        const agents = (state.agents as Array<{ id: string; name: string; ready: boolean }>) || [];
        return [
          'Agentes disponíveis:',
          ...agents.map((a) => `  ${a.name.padEnd(14)}: ${a.ready ? '● ready' : '○ not detected'}`),
        ].join('\n');
      }

      case 'pause_execution':
        return 'Execução pausada com segurança. As worktrees ativas estão preservadas.';

      case 'resume_execution':
        return 'Execução retomada.';

      case 'cancel_and_reassign':
        return `Reatribuição solicitada: ${intent.fromAgent} cancelado na ${intent.taskId}, transferindo para ${intent.preferredReplacement}.`;

      case 'add_constraint':
        return `Restrição adicionada com sucesso ao run atual: ${intent.constraint}`;

      case 'approve_plan':
        return 'Plano aprovado pelo operador. Iniciando execução do grafo de tarefas.';

      case 'reject_plan':
        return 'Plano rejeitado. Aguardando novos parâmetros do operador.';

      case 'inspect_cost':
        return `Uso acumulado: ${state.tokensUsed || 0} tokens (Custo estimado: $${state.estimatedCost || '0.00'})`;

      default:
        return 'Entendi seu pedido. Control plane processando...';
    }
  }
}
