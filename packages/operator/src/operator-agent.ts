import { InteractionScope } from '@taskforge/shared';

export type OperatorIntent =
  | { type: 'inspect_tasks'; taskId?: string }
  | { type: 'inspect_agents' }
  | { type: 'inspect_plan' }
  | { type: 'inspect_cost' }
  | { type: 'inspect_stats' }
  | { type: 'inspect_dashboard' }
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
  | {
      type: 'approve_interaction';
      requestId?: string;
      scope?: InteractionScope;
      rawAnswer?: string;
    }
  | { type: 'deny_interaction'; requestId?: string; reason?: string }
  | { type: 'inspect_pending_interactions' }
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
    if (text.startsWith('/stats')) return { type: 'inspect_stats' };
    if (text.startsWith('/dash') || text.startsWith('/graph') || text.startsWith('/status'))
      return { type: 'inspect_dashboard' };
    if (text.startsWith('/pause')) return { type: 'pause_execution' };
    if (text.startsWith('/resume')) return { type: 'resume_execution' };
    if (text.startsWith('/pending')) return { type: 'inspect_pending_interactions' };

    if (text.startsWith('/approve')) {
      const parts = text.split(/\s+/);
      if (parts.length > 1) {
        return {
          type: 'approve_interaction',
          requestId: parts[1],
          scope: (parts[2] as InteractionScope) ?? 'task',
        };
      }
      return { type: 'approve_plan' };
    }

    if (text.startsWith('/deny')) {
      const parts = text.split(/\s+/);
      return { type: 'deny_interaction', requestId: parts[1], reason: parts.slice(2).join(' ') };
    }

    if (text.startsWith('/reject'))
      return { type: 'reject_plan', feedback: text.replace('/reject', '').trim() };

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
      lower.includes('list tasks') ||
      lower.includes('show tasks') ||
      lower.includes('what is happening') ||
      lower.includes('tasks status') ||
      lower.includes('task status') ||
      lower === 'tasks'
    ) {
      return { type: 'inspect_tasks' };
    }

    if (lower.includes('who is working on')) {
      const taskMatch = text.match(/(TASK-\d+)/i);
      return { type: 'inspect_tasks', taskId: taskMatch ? taskMatch[1].toUpperCase() : undefined };
    }

    if (
      lower.includes('available agents') ||
      lower.includes('show agents') ||
      lower.includes('list agents') ||
      lower.includes('who is available')
    ) {
      return { type: 'inspect_agents' };
    }

    if (
      lower.includes('show plan') ||
      lower.includes('what is the plan') ||
      lower.includes('view plan') ||
      lower.includes('see plan')
    ) {
      return { type: 'inspect_plan' };
    }

    if (
      lower.includes('how much did i spend') ||
      lower.includes('token cost') ||
      lower.includes('cost report') ||
      lower.includes('tokens') ||
      lower === 'cost'
    ) {
      return { type: 'inspect_cost' };
    }

    if (
      lower.includes('pause execution') ||
      lower.includes('stop execution') ||
      lower.includes('halt execution') ||
      lower === 'pause'
    ) {
      return { type: 'pause_execution' };
    }

    if (
      lower.includes('resume execution') ||
      lower.includes('continue execution') ||
      lower === 'resume'
    ) {
      return { type: 'resume_execution' };
    }

    if (
      lower === 'yes' ||
      lower === 'y' ||
      lower.startsWith('yes ') ||
      lower.startsWith('y ') ||
      lower.includes('approve plan') ||
      lower.includes('go ahead') ||
      lower.includes('proceed') ||
      lower.includes('run it')
    ) {
      return { type: 'approve_plan' };
    }

    if (
      lower === 'no' ||
      lower === 'n' ||
      lower.startsWith('no,') ||
      lower.startsWith('no ') ||
      lower.startsWith('n ') ||
      lower.includes('cancel plan') ||
      lower.includes('discard plan') ||
      lower.includes('abort plan') ||
      lower === 'reject' ||
      lower.startsWith('reject ')
    ) {
      return { type: 'reject_plan', feedback: text };
    }

    // Cancel and reassign
    if (lower.includes('reassign')) {
      const taskMatch = text.match(/(TASK-\d+)/i);
      const agentMatch = text.match(/(?:to)\s+([\w-]+)/i);
      return {
        type: 'cancel_and_reassign',
        fromAgent: 'current',
        preferredReplacement: agentMatch ? agentMatch[1] : 'auto',
        taskId: taskMatch ? taskMatch[1].toUpperCase() : 'CURRENT',
      };
    }

    // Scope and constraint patterns
    if (
      lower.startsWith('do not change') ||
      lower.startsWith('do not modify') ||
      lower.startsWith('dont change') ||
      lower.startsWith("don't change") ||
      lower.startsWith('do not touch')
    ) {
      return {
        type: 'add_constraint',
        constraint: text,
      };
    }

    // Read-only scope restriction
    const scopeMatch = text.match(
      /(?:do not allow anyone to (?:write|touch|modify) in)\s+([\w\-./*]+)/i,
    );
    if (scopeMatch) {
      return {
        type: 'add_constraint',
        constraint: `read_only:${scopeMatch[1]}`,
        readOnlyScope: scopeMatch[1],
      };
    }

    const constraintMatch = text.match(/no new dependenc/i);
    if (constraintMatch) {
      return {
        type: 'add_constraint',
        constraint: 'no_new_dependencies',
      };
    }

    // Natural language approvals
    if (
      lower.includes('allow installation') ||
      lower.includes('approve') ||
      lower.includes('allow')
    ) {
      let scope: import('@taskforge/shared').InteractionScope = 'task';
      if (
        lower.includes('only for this task') ||
        lower.includes('just this task')
      ) {
        scope = 'task';
      } else if (
        lower.includes('whole project') ||
        lower.includes('always')
      ) {
        scope = 'project';
      } else if (
        lower.includes('this run')
      ) {
        scope = 'run';
      } else if (
        lower.includes('once') ||
        lower.includes('just once')
      ) {
        scope = 'once';
      }
      return { type: 'approve_interaction', scope, rawAnswer: text };
    }

    if (
      lower.includes('deny') ||
      lower.includes('do not allow') ||
      lower.includes('disallow')
    ) {
      return { type: 'deny_interaction', reason: text };
    }

    // 3. Greetings & Help requests
    if (
      lower === 'hello' ||
      lower === 'hi' ||
      lower === 'help' ||
      lower.startsWith('/help') ||
      lower.includes('what can you do') ||
      lower.includes('how does it work')
    ) {
      return { type: 'general_query', query: text };
    }

    // 4. Any other statement is an engineering objective/goal for TaskForge
    return { type: 'submit_goal', goal: text };
  }
}

export class OperatorAgent {
  public parseIntent(input: string): OperatorIntent {
    return OperatorIntentParser.parse(input);
  }

  public formatResponse(
    intent: OperatorIntent,
    state: Record<string, unknown>,
  ): string {
    switch (intent.type) {
      case 'inspect_tasks': {
        const tasks =
          (state.tasks as Array<{ id: string; title: string; status: string; agent?: string }>) ||
          [];
        if (tasks.length === 0) {
          return 'No active tasks in this run.';
        }
        return [
          'Run tasks:',
          ...tasks.map(
            (t) =>
              `  ● ${t.id}: ${t.title} [${t.status.toUpperCase()}]${t.agent ? ` (Agent: ${t.agent})` : ''}`,
          ),
        ].join('\n');
      }

      case 'inspect_agents': {
        const agents =
          (state.agents as Array<{
            id: string;
            name: string;
            ready: boolean;
            quotaStatus?: string;
            quotaReason?: string;
          }>) || [];
        return [
          'Available agents:',
          ...agents.map((a) => {
            let status = a.ready ? '● ready' : '○ not detected';
            if (a.quotaStatus === 'quota_exhausted') {
              status = `▲ quota exhausted${a.quotaReason ? ` (${a.quotaReason})` : ''}`;
            } else if (a.quotaStatus === 'rate_limited') {
              status = `▲ rate limited${a.quotaReason ? ` (${a.quotaReason})` : ''}`;
            }
            return `  ${a.name.padEnd(16)}: ${status}`;
          }),
        ].join('\n');
      }

      case 'pause_execution':
        return 'Execution paused safely. Active worktrees are preserved.';

      case 'resume_execution':
        return 'Execution resumed.';

      case 'cancel_and_reassign':
        return `Reassignment requested: ${intent.fromAgent} cancelled on ${intent.taskId}, transferring to ${intent.preferredReplacement}.`;

      case 'add_constraint':
        return `Constraint added successfully to current run: ${intent.constraint}`;

      case 'approve_plan':
        return 'Plan approved by operator. Starting task graph execution.';

      case 'reject_plan':
        return 'Plan rejected. Awaiting new parameters from operator.';

      case 'approve_interaction':
        return `✓ allowed${intent.scope ? ` for ${intent.scope}` : ''}. Agent resumed work.`;

      case 'deny_interaction':
        return 'Operation denied by operator.';

      case 'inspect_pending_interactions': {
        const pending =
          (state.pending as Array<{
            id: string;
            agentId: string;
            prompt: string;
            resource?: string;
          }>) || [];
        if (pending.length === 0) {
          return 'No interactions pending human approval.';
        }
        return [
          'Pending interactions awaiting approval:',
          ...pending.map(
            (p) =>
              `  ● [${p.id}] ${p.agentId}: ${p.prompt}${p.resource ? ` (${p.resource})` : ''}`,
          ),
          '',
          'To approve: type "y", "yes", /approve <id> [task|run|project] or respond naturally (e.g. "allow install for this task")',
          'To deny: type "n", "no" or /deny <id>',
        ].join('\n');
      }

      case 'inspect_cost':
        return `Accumulated usage: ${state.tokensUsed || 0} tokens (Estimated cost: $${state.estimatedCost || '0.00'})`;

      default:
        return 'Command received. Control plane processing...';
    }
  }
}
