import { RoleRequest } from './router-types.js';

export type AgentFitSignal =
  | 'architecture_synthesis'
  | 'code_implementation'
  | 'reproduction_and_testing'
  | 'independent_review'
  | 'repository_research'
  | 'interactive_coordination';

export interface AgentFitAssessment {
  agentId: string;
  score: number;
  signals: AgentFitSignal[];
  reason: string;
}

/**
 * Deterministic task-to-agent fit.
 *
 * This is deliberately NOT a historical-performance model. A different
 * repository can make yesterday's latency/token numbers irrelevant. The
 * selector first asks what kind of work this assignment requires, then
 * chooses the harness whose declared strengths best match that work.
 *
 * Availability/quota and hard capabilities are checked before this scorer.
 * Fairness is only a tie-break after fit.
 */
export class AgentFitScorer {
  static assess(agentId: string, request: RoleRequest): AgentFitAssessment {
    const text = `${request.role} ${request.objective}`.toLowerCase();
    const signals = this.detectSignals(text, request);
    let score = 50;
    const reasons: string[] = [];

    const add = (points: number, reason: string) => {
      score += points;
      reasons.push(reason);
    };

    if (agentId === 'claude') {
      if (signals.includes('architecture_synthesis')) add(35, 'strong fit for architecture/synthesis');
      if (signals.includes('independent_review')) add(30, 'strong fit for independent review');
      if (signals.includes('repository_research')) add(20, 'good fit for repository explanation and synthesis');
      if (signals.includes('interactive_coordination')) add(10, 'supports structured interactive coordination');
      if (signals.includes('code_implementation')) add(8, 'capable implementation harness');
    } else if (agentId === 'codex') {
      if (signals.includes('code_implementation')) add(35, 'strong fit for code implementation');
      if (signals.includes('reproduction_and_testing')) add(35, 'strong fit for reproduction and test execution');
      if (signals.includes('independent_review')) add(12, 'capable code review harness');
      if (signals.includes('repository_research')) add(8, 'capable repository investigation');
      if (signals.includes('interactive_coordination')) add(-8, 'non-interactive execution protocol');
    } else if (agentId === 'agy') {
      if (signals.includes('repository_research')) add(28, 'strong fit for exploratory repository research');
      if (signals.includes('interactive_coordination')) add(10, 'supports structured interactive coordination');
      if (signals.includes('architecture_synthesis')) add(12, 'capable architecture analysis');
      if (signals.includes('code_implementation')) add(10, 'capable implementation harness');
      if (signals.includes('reproduction_and_testing')) add(8, 'capable execution harness');
    }

    return {
      agentId,
      score,
      signals,
      reason: reasons.length > 0 ? reasons.join('; ') : 'general capability fit',
    };
  }

  private static detectSignals(text: string, request: RoleRequest): AgentFitSignal[] {
    const signals = new Set<AgentFitSignal>();

    if (
      request.role === 'architecture_reviewer' ||
      /\b(architecture|architect|design|invariant|trade-?off|synthesi[sz]|summar(?:y|i[sz](?:e|ation))|explain|overview|what (?:is|does)|o que|como funciona)\b/i.test(text)
    ) {
      signals.add('architecture_synthesis');
    }

    if (
      request.role === 'implementer' ||
      request.role === 'integrator' ||
      /\b(implement|code|change|modify|fix|refactor|create|add|remove|migrate|integrat)\b/i.test(text)
    ) {
      signals.add('code_implementation');
    }

    if (
      request.role === 'reproduction_engineer' ||
      request.role === 'tester' ||
      /\b(reproduce|reproduction|test|failing|failure|flaky|benchmark|execute|run)\b/i.test(text)
    ) {
      signals.add('reproduction_and_testing');
    }

    if (
      ['reviewer', 'critic', 'security_reviewer', 'architecture_reviewer'].includes(request.role) ||
      /\b(review|audit|critic|security|validate|independent)\b/i.test(text)
    ) {
      signals.add('independent_review');
    }

    if (
      request.role === 'researcher' ||
      /\b(research|investigat|inspect|trace|understand|summari[sz]|repository|repo|codebase|project)\b/i.test(text)
    ) {
      signals.add('repository_research');
    }

    if (/\b(clarif|interactive|coordinate|ask|ambigu|stakeholder)\b/i.test(text)) {
      signals.add('interactive_coordination');
    }

    return [...signals];
  }
}
