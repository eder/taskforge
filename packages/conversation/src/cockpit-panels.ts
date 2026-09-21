import {
  ActiveAgentState,
  InteractionRequest,
  InteractionScope,
  InvestigatorFailoverEvent,
} from '@taskforge/shared';
import { colors, theme } from './theme.js';

function formatReset(resetAt?: string): string | undefined {
  if (!resetAt) return undefined;
  const parsed = new Date(resetAt);
  if (Number.isNaN(parsed.getTime())) return resetAt;
  return parsed.toISOString();
}

export class CockpitPanels {
  public static actionRequired(state: ActiveAgentState): string {
    const attention = state.attentionRequired;
    if (!attention) return '';

    const requestId = attention.requestId ?? '<request-id>';
    const action =
      attention.operation && attention.resource
        ? attention.operation + ' → ' + attention.resource
        : attention.operation ?? attention.resource ?? attention.prompt;
    const category = attention.category
      ? '  ' + colors.dim + 'Category:' + colors.reset + '  ' + attention.category
      : '';

    return theme.box('ACTION REQUIRED', [
      colors.yellow + colors.bold + '▲ Human decision needed' + colors.reset,
      '',
      colors.dim + 'Agent:' + colors.reset + '     ' + colors.bold + state.agentName + colors.reset + ' ' + colors.dim + '(' + state.role + ')' + colors.reset,
      colors.dim + 'Task:' + colors.reset + '      ' + state.taskId + ' — ' + state.taskTitle,
      colors.dim + 'Action:' + colors.reset + '    ' + action,
      category,
      colors.dim + 'Why:' + colors.reset + '       ' + attention.prompt,
      '',
      colors.bold + 'Respond' + colors.reset,
      '  ' + colors.green + '/approve ' + requestId + ' once' + colors.reset + '   allow once',
      '  ' + colors.green + '/approve ' + requestId + ' task' + colors.reset + '   allow for this task',
      '  ' + colors.red + '/deny ' + requestId + colors.reset + '             deny',
      '  ' + colors.cyan + '/pending' + colors.reset + '                       view context',
    ].filter(Boolean), 72);
  }

  public static interactionResolved(
    request: InteractionRequest,
    decision: 'allow' | 'deny',
    scope: InteractionScope,
  ): string {
    const allowed = decision === 'allow';
    const title = allowed ? 'ACTION ALLOWED' : 'ACTION DENIED';
    const color = allowed ? colors.green : colors.red;
    const icon = allowed ? '✓' : '✕';
    const scopeText = allowed ? 'scope: ' + scope : 'agent notified';

    return theme.box(title, [
      color + colors.bold + icon + ' ' + (allowed ? 'Permission granted' : 'Permission denied') + colors.reset,
      colors.dim + 'Agent:' + colors.reset + '     ' + request.agentId,
      colors.dim + 'Task:' + colors.reset + '      ' + request.taskId,
      request.resource ? colors.dim + 'Resource:' + colors.reset + '  ' + request.resource : '',
      colors.dim + 'Result:' + colors.reset + '    ' + (allowed ? 'allowed — ' + scopeText : 'denied — ' + scopeText),
    ].filter(Boolean), 64);
  }

  public static failover(event: InvestigatorFailoverEvent): string {
    const reset = formatReset(event.resetAt);
    if (event.stage === 'provider_failed') {
      return theme.box('PROVIDER FAILOVER', [
        colors.yellow + colors.bold + '⚠ Provider unavailable' + colors.reset,
        colors.dim + 'Task:' + colors.reset + '      ' + event.taskId,
        colors.dim + 'Role:' + colors.reset + '      ' + event.role,
        colors.dim + 'Failed:' + colors.reset + '    ' + event.failedAgentName,
        event.reason ? colors.dim + 'Reason:' + colors.reset + '    ' + event.reason : '',
        reset ? colors.dim + 'Reset:' + colors.reset + '     ' + reset : '',
        colors.cyan + '↻ Searching for a healthy replacement...' + colors.reset,
      ].filter(Boolean), 72);
    }

    if (event.stage === 'reassigning') {
      return theme.box('PROVIDER FAILOVER', [
        colors.yellow + event.failedAgentName + colors.reset + ' unavailable',
        colors.cyan + '↻ Reassigning ' + event.role + ' → ' + (event.replacementAgentName ?? event.replacementAgentId ?? 'replacement') + colors.reset,
        event.reason ? colors.dim + 'Reason:' + colors.reset + ' ' + event.reason : '',
        reset ? colors.dim + 'Reset:' + colors.reset + '  ' + reset : '',
      ].filter(Boolean), 72);
    }

    return theme.box('PROVIDER RECOVERED', [
      colors.yellow + event.failedAgentName + colors.reset + ' unavailable',
      colors.cyan + '↻ ' + event.role + ' reassigned → ' + (event.replacementAgentName ?? event.replacementAgentId ?? 'replacement') + colors.reset,
      colors.green + colors.bold + '✓ Recovered' + colors.reset,
      event.reason ? colors.dim + 'Reason:' + colors.reset + ' ' + event.reason : '',
      reset ? colors.dim + 'Original provider reset:' + colors.reset + ' ' + reset : '',
    ].filter(Boolean), 72);
  }
}
