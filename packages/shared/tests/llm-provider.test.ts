import { describe, expect, it } from 'vitest';
import type {
  LLMHealthReport,
  LLMProvider,
  LLMProviderMetadata,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from '../src/llm-provider.js';

class FixtureProvider implements LLMProvider {
  readonly metadata: LLMProviderMetadata = {
    provider: 'fixture',
    model: 'fixture-model',
    baseUrl: 'https://example.invalid/v1',
  };

  async generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationResult> {
    expect(request.schemaName).toBe('fixture_response');
    return { value: { accepted: true }, metadata: this.metadata };
  }

  async healthCheck(): Promise<LLMHealthReport> {
    return { ...this.metadata, status: 'healthy' };
  }
}

describe('LLMProvider', () => {
  it('standardizes structured generation, metadata, and health without validating caller data', async () => {
    const provider = new FixtureProvider();
    const result = await provider.generateStructured({
      messages: [{ role: 'user', content: 'return JSON' }],
      schemaName: 'fixture_response',
      schema: { type: 'object' },
    });

    expect(result.value).toEqual({ accepted: true });
    expect(result.metadata).toEqual(provider.metadata);
    await expect(provider.healthCheck()).resolves.toMatchObject({
      status: 'healthy',
      provider: 'fixture',
      model: 'fixture-model',
    });
  });
});
