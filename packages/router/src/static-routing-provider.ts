import { RoutingProvider, RoutingInput, RoutingDecision, RouterHealthReport } from './router-types.js';
import { RouterQualityGuard } from './quality-guard.js';

export class StaticRoutingProvider implements RoutingProvider {
  readonly id = 'static';

  async healthCheck(): Promise<RouterHealthReport> {
    return {
      status: 'healthy',
      provider: this.id,
      adaptive: false,
      details: 'Deterministic rule-based routing active',
    };
  }

  async route(input: RoutingInput): Promise<RoutingDecision> {
    const desc =
      `${input.task.title} ${input.task.description} ${input.task.contract.objective}`.toLowerCase();

    const isInvestigation =
      input.task.type === 'investigation' ||
      desc.includes('investiga') ||
      desc.includes('bug') ||
      desc.includes('reproduce') ||
      desc.includes('flaky') ||
      desc.includes('duplicat') ||
      input.signals?.uncertainty === 'high';

    const isHighRisk =
      desc.includes('security') ||
      desc.includes('pagamento') ||
      desc.includes('payment') ||
      desc.includes('finance') ||
      desc.includes('auth') ||
      desc.includes('deadlock') ||
      desc.includes('race') ||
      desc.includes('concurrency') ||
      input.signals?.risk === 'high';

    let decision: RoutingDecision;

    if (isInvestigation) {
      decision = {
        strategy: 'parallel',
        complexity: 'high',
        risk: isHighRisk ? 'high' : 'medium',
        uncertainty: 'high',
        teamSize: 3,
        roles: [
          {
            role: 'reproduction_engineer',
            requiredCapabilities: ['canExecute', 'canWrite'],
            objective: 'Reproduce problem and generate minimal failing test or trace',
            preferredAgent: 'codex',
          },
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: 'Trace flow paths and analyze idempotency/data flow',
            preferredAgent: 'agy',
          },
          {
            role: 'architecture_reviewer',
            requiredCapabilities: ['canRead', 'canWrite'],
            objective: 'Analyze consistency invariants and recommend architecture fix',
            preferredAgent: 'claude',
          },
        ],
        communication: {
          required: true,
          initialAlignment: true,
          synthesisBeforeImplementation: true,
        },
        reason:
          'Task exhibits high uncertainty and potential financial or consistency risk: parallel investigation with multi-agent evidence synthesis selected.',
        source: 'static',
      };
    } else if (isHighRisk || input.task.type === 'review') {
      decision = {
        strategy: 'review',
        complexity: 'medium',
        risk: 'high',
        uncertainty: 'low',
        teamSize: 2,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite', 'canExecute'],
            objective: input.task.contract.objective,
            preferredAgent: 'codex',
          },
          {
            role: 'reviewer',
            requiredCapabilities: ['canRead'],
            objective:
              'Independent review of implementation against contract and security constraints',
            preferredAgent: 'claude',
          },
        ],
        communication: {
          required: true,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'Sensitive or high-risk component requires independent validation gate.',
        source: 'static',
      };
    } else {
      // Default minimal sufficient team: 1 worker
      decision = {
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'implementer',
            requiredCapabilities: ['canWrite', 'canExecute'],
            objective: input.task.contract.objective,
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason:
          'Straightforward engineering task with clear boundaries: minimum sufficient team is 1 worker.',
        source: 'static',
      };
    }

    return RouterQualityGuard.evaluate(decision, input);
  }
}
