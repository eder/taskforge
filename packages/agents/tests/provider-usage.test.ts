import { describe, expect, it } from 'vitest';
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
} from '../src/real-adapters.js';

describe('provider-reported usage normalization', () => {
  it('normalizes Claude Code stream-json usage and model metadata', () => {
    const adapter = new ClaudeCodeAdapter();
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 500,
        output_tokens: 450,
      },
      modelUsage: {
        'claude-sonnet-test': {
          inputTokens: 1200,
          cacheCreationInputTokens: 300,
          cacheReadInputTokens: 500,
          outputTokens: 450,
        },
      },
    });

    const usage = adapter.extractReportedUsage(stdout, '');

    expect(usage).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 800,
      outputTokens: 450,
      totalTokens: 2450,
      modelName: 'claude-sonnet-test',
      source: 'provider_reported',
    });
  });

  it('normalizes Codex/OpenAI-style usage without double-counting cumulative snapshots', () => {
    const adapter = new CodexAdapter();
    const stdout = [
      JSON.stringify({
        type: 'turn.progress',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 200,
          output_tokens: 100,
          total_tokens: 1300,
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        model: 'gpt-codex-test',
        usage: {
          input_tokens: 2200,
          cached_input_tokens: 700,
          output_tokens: 500,
          total_tokens: 3400,
        },
      }),
    ].join('\n');

    const usage = adapter.extractReportedUsage(stdout, '');

    expect(usage?.modelName).toBe('gpt-codex-test');
    expect(usage?.inputTokens).toBe(2200);
    expect(usage?.cachedInputTokens).toBe(700);
    expect(usage?.outputTokens).toBe(500);
    expect(usage?.totalTokens).toBe(3400);
  });

  it('normalizes Gemini/Antigravity usageMetadata shape', () => {
    const adapter = new AntigravityAdapter();
    const stdout = JSON.stringify({
      event: 'result',
      model: 'gemini-test',
      usageMetadata: {
        promptTokenCount: 1800,
        cachedContentTokenCount: 400,
        candidatesTokenCount: 350,
        totalTokenCount: 2550,
      },
    });

    const usage = adapter.extractReportedUsage(stdout, '');

    expect(usage).toEqual({
      inputTokens: 1800,
      cachedInputTokens: 400,
      outputTokens: 350,
      totalTokens: 2550,
      modelName: 'gemini-test',
      source: 'provider_reported',
    });
  });

  it('does not scrape usage-looking JSON embedded inside assistant response text', () => {
    const adapter = new ClaudeCodeAdapter();
    const stdout = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '{"usage":{"input_tokens":999999,"output_tokens":999999}}',
          },
        ],
      },
    });

    expect(adapter.extractReportedUsage(stdout, '')).toBeUndefined();
  });
});
