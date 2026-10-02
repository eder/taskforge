import { describe, it, expect } from 'vitest';
import { AntigravityAdapter } from '../src/antigravity-adapter.js';

// Shape captured from a real `agy --output-format stream-json -p ...` run
// (the long "init.tools" list is omitted).
const init = JSON.stringify({ event: 'init', conversation_id: 'c1', init: { cwd: '/repo', permission_mode: 'request-review' } });
const userStep = JSON.stringify({
  event: 'step_update',
  step_update: { conversation_id: 'c1', step_index: 0, state: 'DONE', step_type: 'user_input' },
});
const agentStep = (text: string) =>
  JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: text },
  });
const result = (status: string, response: string) =>
  JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c1',
      status,
      response,
      num_turns: 1,
      usage: { input_tokens: 12361, output_tokens: 56, thinking_tokens: 55, cache_read_tokens: 0, total_tokens: 12417 },
    },
  });

describe('Antigravity stream-json output', () => {
  const adapter = new AntigravityAdapter();

  it('extracts the final response from the {"event":"result"} line (it used to be empty)', () => {
    const stdout = [init, userStep, agentStep('OK\n'), result('SUCCESS', 'OK\n')].join('\n');
    const outcome = adapter.normalizeOutcome(stdout, '', 0);
    expect(outcome.finalResponse).toBe('OK');
    expect(outcome.providerStatus).toBe('SUCCESS');
    expect(outcome.usage?.totalTokens).toBe(12417);
    expect(adapter['extractOutput'](stdout, '', outcome)).toBe('OK');
  });

  it('keeps a long multi-paragraph report intact', () => {
    const report = '## Analysis\n\nFirst finding.\n\n- item one\n- item two\n\nConclusion.';
    const outcome = adapter.normalizeOutcome([init, result('SUCCESS', report)].join('\n'), '', 0);
    expect(outcome.finalResponse).toBe(report);
  });

  it('falls back to the agent reply deltas when the stream ends without a result event', () => {
    const stdout = [init, userStep, agentStep('Partial '), agentStep('analysis so far.')].join('\n');
    const outcome = adapter.normalizeOutcome(stdout, '', 0);
    expect(outcome.finalResponse).toContain('Partial');
    expect(outcome.finalResponse).toContain('analysis so far.');
  });

  it('reports the nested provider status instead of assuming success from the exit code', () => {
    const outcome = adapter.normalizeOutcome([init, result('FAILED', '')].join('\n'), '', 0);
    expect(outcome.providerStatus).toBe('FAILED');
  });

  it('does not invent a response when the provider returned none', () => {
    const outcome = adapter.normalizeOutcome([init, userStep].join('\n'), '', 0);
    expect(outcome.finalResponse).toBe('');
  });
});
