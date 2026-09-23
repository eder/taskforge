import { z } from 'zod';
import { PerformanceEngine } from '@taskforge/telemetry';
import {
  RoutingProvider,
  RoutingInput,
  RoutingDecision,
  RouterFallbackReason,
  RouterHealthReport,
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
  private failureCooldown?: { reason: RouterFallbackReason; until: number };
  private readonly failureCooldownMs = 30_000;

  constructor(
    private apiKey?: string,
    private model: string = 'gpt-5.6-luna',
    private timeoutMs: number = 15000,
    options: { performanceEngine?: PerformanceEngine } = {},
  ) {
    void options.performanceEngine; // retained for API compatibility; history is observational, not selection input.
    if (this.apiKey === undefined) {
      this.apiKey =
        process.env.TASKFORGE_OPENAI_API_KEY ||
        process.env.OPENAI_API_KEY;
    }
  }

  private validationCache?: { valid: boolean; error?: string; checkedAt: number };

  async healthCheck(options: import('./router-types.js').HealthCheckOptions = {}): Promise<RouterHealthReport> {
    const hasKey = Boolean(this.apiKey && this.apiKey.trim().length > 0);
    if (!hasKey) {
      return {
        status: 'degraded',
        provider: this.id,
        model: this.model,
        adaptive: false,
        details:
          'OpenAI routing missing API key (set TASKFORGE_OPENAI_API_KEY or configure router.apiKey in ~/.taskforge/config.yaml); requests will fall back to static',
      };
    }

    if (options.validateKey) {
      const now = Date.now();
      if (this.validationCache && now - this.validationCache.checkedAt < 60000) {
        if (!this.validationCache.valid) {
          return {
            status: 'degraded',
            provider: this.id,
            model: this.model,
            adaptive: false,
            details: `OpenAI key invalid: ${this.validationCache.error} (check TASKFORGE_OPENAI_API_KEY or ~/.taskforge/config.yaml); requests will fall back to static`,
          };
        }
      } else {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const res = await fetch('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: { Authorization: `Bearer ${this.apiKey}` },
            signal: controller.signal,
          }).finally(() => clearTimeout(timeout));

          if (!res.ok) {
            let errMsg = `HTTP ${res.status}`;
            if (res.status === 401) {
              errMsg = 'invalid API key (HTTP 401)';
            } else if (res.status === 429) {
              errMsg = 'quota exceeded or rate limited (HTTP 429)';
            }
            this.validationCache = { valid: false, error: errMsg, checkedAt: now };
            return {
              status: 'degraded',
              provider: this.id,
              model: this.model,
              adaptive: false,
              details: `OpenAI key validation failed: ${errMsg} (requests will fall back to static)`,
            };
          }
          this.validationCache = { valid: true, checkedAt: now };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 'degraded',
            provider: this.id,
            model: this.model,
            adaptive: false,
            details: `OpenAI endpoint connectivity issue: ${msg}`,
          };
        }
      }
    }

    return {
      status: 'healthy',
      provider: this.id,
      model: this.model,
      adaptive: false,
      details: `OpenAI routing active with model ${this.model}`,
    };
  }

  private async makeFallback(
    input: RoutingInput,
    reason: RouterFallbackReason,
    detail?: string,
  ): Promise<RoutingDecision> {
    const base = await this.fallbackProvider.route(input);
    const decision: RoutingDecision = {
      ...base,
      source: 'fallback',
      provider: 'openai',
      model: this.model,
      fallbackReason: reason,
      fallbackDetail: detail,
      reason: `[Fallback from OpenAI/${this.model} (${reason}${detail ? `: ${detail}` : ''})]: ${base.reason}`,
    };
    return RouterQualityGuard.evaluate(decision, input);
  }

  async route(input: RoutingInput): Promise<RoutingDecision> {
    if (!this.apiKey || !this.apiKey.trim()) {
      return this.makeFallback(input, 'provider_unavailable');
    }

    if (this.failureCooldown && Date.now() < this.failureCooldown.until) {
      return this.makeFallback(input, this.failureCooldown.reason);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const quotaTracker = AgentQuotaTracker.getInstance();
      const healthyAgents = input.availableAgents.filter((id) => quotaTracker.isAvailable(id));
      const agentsForRouting = healthyAgents.length > 0 ? healthyAgents : input.availableAgents;

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
                'You are the TaskForge routing controller.\n\nYour only responsibility is deciding how an engineering task should be staffed and executed.\nYou do not implement code, change tasks, execute commands, or control Git.\n\nEvaluate complexity, uncertainty, risk, task size, change surface, dependency ambiguity, need for independent validation, available capabilities, availability, and expected collaboration cost. Agent identity should be chosen from the current task fit, never from cross-project historical averages.\n\nChoose the minimum team required to safely complete the task.\nPrefer a single agent for straightforward work.\nEscalate collaboration only when the expected benefit justifies extra cost and coordination.\nReturn only the strict structured routing decision.',
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
        this.failureCooldown = {
          reason,
          until: Date.now() + this.failureCooldownMs,
        };
        return this.makeFallback(input, reason, `HTTP ${response.status}`);
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

      this.failureCooldown = undefined;
      return RouterQualityGuard.evaluate(decision, input);
    } catch (err) {
      const isTimeout =
        controller.signal.aborted ||
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof Error && err.message.toLowerCase().includes('timeout'));
      const reason: RouterFallbackReason = isTimeout ? 'timeout' : 'unknown';
      this.failureCooldown = {
        reason,
        until: Date.now() + this.failureCooldownMs,
      };
      return this.makeFallback(input, reason);
    } finally {
      clearTimeout(timeout);
    }
  }
}
