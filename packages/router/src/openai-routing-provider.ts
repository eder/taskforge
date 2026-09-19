import { RoutingProvider, RoutingInput, RoutingDecision } from './router-types.js';
import { StaticRoutingProvider } from './static-routing-provider.js';
import { AgentQuotaTracker } from '@taskforge/agents';

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

  constructor(
    private apiKey?: string,
    private model: string = 'gpt-5.6-luna',
    private timeoutMs: number = 15000,
  ) {
    if (!this.apiKey) {
      this.apiKey = process.env.OPENAI_API_KEY;
    }
  }

  async route(input: RoutingInput): Promise<RoutingDecision> {
    if (!this.apiKey) {
      // Fallback immediately if no key configured
      return this.fallbackProvider.route(input);
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
        return this.fallbackProvider.route(input);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        return this.fallbackProvider.route(input);
      }

      return JSON.parse(content) as RoutingDecision;
    } catch {
      // Fallback cleanly on error or timeout
      return this.fallbackProvider.route(input);
    } finally {
      clearTimeout(timeout);
    }
  }
}
