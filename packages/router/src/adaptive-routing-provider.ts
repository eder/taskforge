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
    _options: AdaptiveRoutingOptions = {},
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
    // Structural routing remains adaptive-capable, but agent identity is not
    // selected from historical averages. Repositories and requests vary too
    // much for cross-run performance to be a trustworthy primary selector.
    // AgentSelector applies current-task fit after availability/capabilities.
    const baseDecision = await this.fallbackProvider.route(input);
    return {
      ...baseDecision,
      source: 'adaptive',
      roles: baseDecision.roles.map((role) => ({
        ...role,
        preferredAgent: undefined,
      })),
      reason:
        `${baseDecision.reason}\nAgent selection: current-task fit; historical performance is observational only.`,
      provenance: {
        source: 'adaptive',
        fallbackReason: baseDecision.fallbackReason,
        routerProposal: baseDecision.routerProposal,
        policyAdjustment: baseDecision.policyAdjustment,
      },
    };

}
  }
}
