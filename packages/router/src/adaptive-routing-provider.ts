import { PerformanceEngine } from '@taskforge/telemetry';
import { RoutingProvider, RoutingInput, RoutingDecision, RouterHealthReport } from './router-types.js';
import { StaticRoutingProvider } from './static-routing-provider.js';

export interface AdaptiveRoutingOptions {
  minConfidence?: 'high' | 'medium' | 'low';
}

export class AdaptiveRoutingProvider implements RoutingProvider {
  readonly id = 'adaptive';

  constructor(
    private performanceEngine: PerformanceEngine,
    private fallbackProvider: RoutingProvider = new StaticRoutingProvider(),
    private options: AdaptiveRoutingOptions = {},
  ) {}

  async healthCheck(): Promise<RouterHealthReport> {
    const fallbackHealth = this.fallbackProvider.healthCheck
      ? await this.fallbackProvider.healthCheck()
      : { status: 'healthy' as const, provider: this.fallbackProvider.id, adaptive: false };
    const hasEngine = Boolean(this.performanceEngine);
    const isHealthy = hasEngine && fallbackHealth.status !== 'unhealthy';
    return {
      status: isHealthy ? 'healthy' : 'degraded',
      provider: this.id,
      adaptive: true,
      details: hasEngine
        ? `Adaptive engine active with fallback: ${this.fallbackProvider.id}`
        : 'Performance engine not attached, falling back to static',
    };
  }

  async route(input: RoutingInput): Promise<RoutingDecision> {
    // 1. Obtain structural team baseline from fallback provider
    const baseDecision = await this.fallbackProvider.route(input);

    if (!this.performanceEngine) {
      return {
        ...baseDecision,
        source: 'adaptive',
        fallbackReason: 'unknown',
        provenance: {
          source: 'adaptive',
          fallbackReason: 'unknown',
          policyAdjustment: baseDecision.policyAdjustment ?? baseDecision.provenance?.policyAdjustment,
          routerProposal: baseDecision.routerProposal ?? baseDecision.provenance?.routerProposal,
        },
      };
    }

    const minConfidence = this.options.minConfidence ?? 'medium';
    const candidateAgentIds = input.availableAgents;

    const adaptiveRoles = [...baseDecision.roles];
    const explanations: string[] = [];

    for (let i = 0; i < adaptiveRoles.length; i++) {
      const roleReq = { ...adaptiveRoles[i] };
      let bestAgentId: string | undefined = roleReq.preferredAgent;
      let highestScore = -1;
      let bestConfidence: 'high' | 'medium' | 'low' = 'low';
      let bestSampleSize = 0;

      for (const agentId of candidateAgentIds) {
        const stats = this.performanceEngine.getAgentStats({
          agentId,
          role: roleReq.role,
          taskType: input.task.type,
          complexity: baseDecision.complexity,
        });

        const isConfidenceAcceptable =
          minConfidence === 'low' ||
          (minConfidence === 'medium' &&
            (stats.confidence === 'medium' || stats.confidence === 'high')) ||
          (minConfidence === 'high' && stats.confidence === 'high');

        if (isConfidenceAcceptable && stats.sampleSize > 0) {
          if (stats.compositeScore > highestScore) {
            highestScore = stats.compositeScore;
            bestAgentId = agentId;
            bestConfidence = stats.confidence;
            bestSampleSize = stats.sampleSize;
          }
        }
      }

      if (highestScore > 0 && bestAgentId) {
        roleReq.preferredAgent = bestAgentId;
        explanations.push(
          `Role [${roleReq.role}] assigned to ${bestAgentId} based on historical composite score ${highestScore.toFixed(2)} (Sample size: ${bestSampleSize}, Confidence: ${bestConfidence.toUpperCase()}).`,
        );
      } else {
        explanations.push(
          `Role [${roleReq.role}] kept default ${roleReq.preferredAgent ?? 'unspecified'}: insufficient historical data (Confidence: LOW, uncertainty preserved).`,
        );
      }

      adaptiveRoles[i] = roleReq;
    }

    return {
      ...baseDecision,
      source: 'adaptive',
      roles: adaptiveRoles,
      reason: `${baseDecision.reason}\nAdaptive Signals:\n${explanations.join('\n')}`,
      provenance: {
        source: 'adaptive',
        fallbackReason: baseDecision.fallbackReason,
        routerProposal: baseDecision.routerProposal,
        policyAdjustment: baseDecision.policyAdjustment,
      },
    };
  }
}
