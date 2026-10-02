import {
  AgentUsage,
} from '@taskforge/shared';

function finiteTokenNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function firstTokenNumber(obj: any, keys: string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = finiteTokenNumber(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function usageFromObject(raw: any, modelName?: string): AgentUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const rawInputTokens =
    firstTokenNumber(raw, [
      'input_tokens',
      'inputTokens',
      'prompt_tokens',
      'promptTokens',
      'promptTokenCount',
    ]) ?? 0;
  const outputTokens =
    firstTokenNumber(raw, [
      'output_tokens',
      'outputTokens',
      'completion_tokens',
      'completionTokens',
      'candidatesTokenCount',
    ]) ?? 0;

  // OpenAI/Codex and Gemini report cached input as a subset of input tokens.
  // Claude reports cache read/creation as separate input categories. Normalize
  // both shapes into one invariant:
  //
  //   inputTokens       = all observed input, including cached input
  //   cachedInputTokens = subset of inputTokens
  //   totalTokens       = inputTokens + outputTokens
  //
  // This prevents telemetry/cost reporting from counting cache twice.
  const directCached =
    firstTokenNumber(raw, [
      'cached_input_tokens',
      'cachedInputTokens',
      'cached_tokens',
      'cachedTokens',
      'cachedContentTokenCount',
    ]) ?? 0;
  const cacheRead =
    firstTokenNumber(raw, ['cache_read_input_tokens', 'cacheReadInputTokens']) ?? 0;
  const cacheCreation =
    firstTokenNumber(raw, ['cache_creation_input_tokens', 'cacheCreationInputTokens']) ?? 0;
  const additiveCached = cacheRead + cacheCreation;
  const cachedInputTokens = directCached > 0 ? directCached : additiveCached;
  const inputTokens = rawInputTokens + (directCached > 0 ? 0 : additiveCached);

  const providerTotal = firstTokenNumber(raw, [
    'total_tokens',
    'totalTokens',
    'totalTokenCount',
  ]);
  const normalizedTotal = inputTokens + outputTokens;
  // Trust a provider total only when it follows the normalized invariant.
  // Older/malformed harnesses have reported totals that add cached input twice.
  const totalTokens =
    providerTotal !== undefined && providerTotal === normalizedTotal
      ? providerTotal
      : normalizedTotal;

  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cachedInputTokens > 0 ? cachedInputTokens : undefined,
    totalTokens,
    modelName,
    source: 'provider_reported',
  };
}
