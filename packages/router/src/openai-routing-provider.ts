import { z } from 'zod';
import { PerformanceEngine } from '@taskforge/telemetry';
import {
  RoutingProvider,
  RoutingInput,
  RoutingDecision,
  RouterFallbackReason,
} from './router-types.js';
import { StaticRoutingProvider } from './static-routing-provider.js';
import { RouterQualityGuard } from './quality-guard.js';
import { AgentQuotaTracker } from '@taskforge/agents';

export const RoleRequestSchema = z.object({
  role: z.enum([
    'lead',
    'implementer',
    'researcher',
    'architecture_reviewer',
    'reviewer',
    'critic',
    'tester',
    'reproduction_engineer',
    'security_reviewer',
    'integrator',
  ]),
  requiredCapabilities: z.array(z.string()),
  objective: z.string(),
  preferredAgent: z.string().optional(),
});

export const RoutingDecisionSchema = z.object({
  strategy: z.enum([
    'single',
    'pair',
    'parallel',
    'partitioned',
    'competitive',
    'review',
    'collaborative',
    'swarm',
  ]),
  complexity: z.enum(['low', 'medium', 'high']),
  risk: z.enum(['low', 'medium', 'high']),
  uncertainty: z.enum(['low', 'medium', 'high']),
  teamSize: z.number().int().min(1),
  roles: z.array(RoleRequestSchema).min(1),
  communication: z.object({
    required: z.boolean(),
    initialAlignment: z.boolean(),
    synthesisBeforeImplementation: z.boolean(),
  }),
  reason: z.string(),
});

export const ROUTING_DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    strategy: {
      type: 'string',
      enum: [
        'single',
        'pair',
        'parallel',
        'partitioned',
        'competitive',
        'review',
        'collaborative',
        'swarm',
      ],
    },
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
    teamSize: { type: 'integer' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: [
              'lead',
              'implementer',
              'researcher',
              'architecture_reviewer',
              'reviewer',
              'critic',
              'tester',
              'reproduction_engineer',
              'security_reviewer',
              'integrator',
            ],
          },
          requiredCapabilities: { type: 'array', items: { type: 'string' } },
          objective: { type: 'string' },
          preferredAgent: { type: 'string' },
        },
        required: ['role', 'requiredCapabilities', 'objective'],
        additionalProperties: false,
      },
    },
    communication: {
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        initialAlignment: { type: 'boolean' },
        synthesisBeforeImplementation: { type: 'boolean' },
      },
      required: ['required', 'initialAlignment', 'synthesisBeforeImplementation'],
      additionalProperties: false,
    },
    reason: { type: 'string' },
  },
  required: [
    'strategy',
    'complexity',
    'risk',
    'uncertainty',
    'teamSize',
    'roles',
    'communication',
    'reason',
  ],
  additionalProperties: false,
};

export class OpenAIRoutingProvider implements RoutingProvider {
  readonly id = 'openai';
  private fallbackProvider = new StaticRoutingProvider();
  private performanceEngine?: PerformanceEngine;

  constructor(
    private apiKey?: string,
    private model: string = 'gpt-5.6-luna',
    private timeoutMs: number = 15000,
    options: { performanceEngine?: PerformanceEngine } = {},
  ) {
    this.performanceEngine = options.performanceEngine;
    if (this.apiKey === undefined) {
      this.apiKey = process.env.OPENAI_API_KEY;
    }
  }

  private async makeFallback(
    input: RoutingInput,
    reason: RouterFallbackReason,
  ): Promise<RoutingDecision> {
    const base = await this.fallbackProvider.route(input);
    const decision: RoutingDecision = {
      ...base,
      source: 'fallback',
      provider: 'openai',
      model: this.model,
      fallbackReason: reason,
      reason: `[Fallback from OpenAI/${this.model} (${reason})]: ${base.reason}`,
    };
    return RouterQualityGuard.evaluate(decision, input);
  }

  async route(input: RoutingInput): Promise<RoutingDecision> {
    if (!this.apiKey || !this.apiKey.trim()) {
      return this.makeFallback(input, 'provider_unavailable');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const quotaTracker = AgentQuotaTracker.getInstance();
      const healthyAgents = input.availableAgents.filter((id) => quotaTracker.isAvailable(id));
      const agentsForRouting = healthyAgents.length > 0 ? healthyAgents : input.availableAgents;

      // Extract historical performance if performanceEngine is configured
      const historicalPerformance: Record<string, unknown> = {};
      if (this.performanceEngine) {
        for (const agentId of agentsForRouting) {
          try {
            const stats = this.performanceEngine.getAgentStats({
              agentId,
              role: 'implementer',
              taskType: input.task.type,
            });
            historicalPerformance[agentId] = {
              sampleSize: stats.sampleSize,
              successRate: stats.successRate,
              firstPassRate: stats.firstPassRate,
              avgDurationMs: stats.averageDurationMs,
              costPerSuccessfulTask: stats.costPerSuccessfulTask,
              reworkRate: stats.reworkRate,
              compositeScore: stats.compositeScore,
              confidence: stats.confidence,
            };
          } catch {
            // ignore telemetry query failure
          }
        }
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'You are the TaskForge routing controller.\n\nYour only responsibility is deciding how an engineering task should be staffed and executed.\nYou do not implement code, change tasks, execute commands, or control Git.\n\nEvaluate complexity, uncertainty, risk, task size, change surface, dependency ambiguity, need for independent validation, available capabilities, historical performance, availability, and expected collaboration cost.\n\nChoose the minimum team required to safely complete the task.\nPrefer a single agent for straightforward work.\nEscalate collaboration only when the expected benefit justifies extra cost and coordination.\nReturn only the strict structured routing decision.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                task: {
                  id: input.task.id,
                  title: input.task.title,
                  description: input.task.description,
                  type: input.task.type,
                  contract: input.task.contract,
                },
                repository: input.repository,
                signals: input.signals,
                availableAgents: agentsForRouting,
                historicalPerformance:
                  Object.keys(historicalPerformance).length > 0 ? historicalPerformance : undefined,
              }),
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'routing_decision',
              strict: true,
              schema: ROUTING_DECISION_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const reason: RouterFallbackReason = response.status === 429 ? 'quota' : 'http_error';
        return this.makeFallback(input, reason);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        return this.makeFallback(input, 'empty_response');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return this.makeFallback(input, 'invalid_schema');
      }

      const parseResult = RoutingDecisionSchema.safeParse(parsed);
      if (!parseResult.success) {
        return this.makeFallback(input, 'invalid_schema');
      }

      const decision: RoutingDecision = {
        ...parseResult.data,
        source: 'openai',
        provider: 'openai',
        model: this.model,
        promptVersion: 'v1.0',
      };

      return RouterQualityGuard.evaluate(decision, input);
    } catch (err) {
      const isTimeout =
        controller.signal.aborted ||
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof Error && err.message.toLowerCase().includes('timeout'));
      return this.makeFallback(input, isTimeout ? 'timeout' : 'unknown');
    } finally {
      clearTimeout(timeout);
    }
  }
}
