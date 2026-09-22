/**
 * Provider-neutral contract used by control-plane consumers of an LLM.
 *
 * Implementations translate this request to a provider's protocol, but must
 * never expose credentials through metadata, errors, or results.  The result
 * is intentionally `unknown`: the caller owns the Zod schema and must
 * validate it before using it for planning or routing.
 */

export type LLMProviderId = string;

export type LLMMessageRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
}

export interface LLMProviderMetadata {
  /** Stable provider identifier for health and decision provenance. */
  provider: LLMProviderId;
  /** The model selected for this provider instance. */
  model: string;
  /** Optional non-secret endpoint identifier, useful for custom providers. */
  baseUrl?: string;
}

export interface StructuredGenerationRequest {
  messages: readonly LLMMessage[];
  /** JSON Schema supplied by the control plane; providers must not own it. */
  schema: Record<string, unknown>;
  /** A stable schema name when a protocol supports named structured output. */
  schemaName: string;
  timeoutMs?: number;
}

export interface StructuredGenerationResult {
  /** Provider-normalized response. Validate this with the caller's schema. */
  value: unknown;
  metadata: LLMProviderMetadata;
}

export type LLMHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface LLMHealthReport extends LLMProviderMetadata {
  status: LLMHealthStatus;
  /** Safe operator-facing detail. It must not include secrets. */
  details?: string;
}

/**
 * Small protocol boundary shared by SemanticPlanner and Router.
 *
 * Provider adapters only normalize transport and native structured-output
 * features. Retries, schema validation, quality guards, provenance ownership,
 * and deterministic fallbacks remain responsibilities of control-plane
 * consumers.
 */
export interface LLMProvider {
  readonly metadata: LLMProviderMetadata;
  generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationResult>;
  healthCheck(options?: { validateCredentials?: boolean }): Promise<LLMHealthReport>;
}

export type LLMProviderErrorKind =
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'transport'
  | 'invalid_response'
  | 'unavailable'
  | 'unknown';

/** A safe, provider-neutral error for consumers' retry/fallback policies. */
export class LLMProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: LLMProviderErrorKind = 'unknown',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}
