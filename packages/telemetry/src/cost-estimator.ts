import { ModelPricing } from './types.js';

export class CostEstimator {
  private static readonly MODEL_PRICING: Record<string, ModelPricing> = {
    // Anthropic models ($ per 1M tokens)
    'claude-3-7-sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    'claude-3-5-sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    'claude': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    'claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25 },

    // OpenAI models ($ per 1M tokens)
    'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    'gpt-5.6-luna': { inputPerMillion: 2.0, outputPerMillion: 8.0 },
    'gpt-5.6-terra': { inputPerMillion: 5.0, outputPerMillion: 20.0 },
    'codex': { inputPerMillion: 2.5, outputPerMillion: 10.0 },

    // Google models ($ per 1M tokens)
    'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.0 },
    'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    'gemini': { inputPerMillion: 1.25, outputPerMillion: 5.0 },

    // Default fallback ($3 / $15)
    default: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  };

  static getPricing(modelName: string): ModelPricing {
    const key = modelName.toLowerCase().trim();
    return this.MODEL_PRICING[key] ?? this.MODEL_PRICING['default'];
  }

  static estimateCost(modelName: string, inputTokens: number, outputTokens: number): number {
    const pricing = this.getPricing(modelName);
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
    return Number((inputCost + outputCost).toFixed(6));
  }
}
