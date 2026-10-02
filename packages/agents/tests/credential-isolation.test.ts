import { describe, it, expect } from 'vitest';
import { sanitizeEnvironment } from '@taskforge/execution';
import { buildAgentEnvAllowlist } from '../src/base-cli-adapter.js';
import { ClaudeCodeAdapter } from '../src/claude-code-adapter.js';
import { CodexAdapter } from '../src/codex-adapter.js';
import { AntigravityAdapter } from '../src/antigravity-adapter.js';
import { AiderAdapter } from '../src/extended-adapters.js';

const PARENT_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  ANTHROPIC_API_KEY: 'sk-ant',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  OPENAI_API_KEY: 'sk-openai',
  CODEX_API_KEY: 'codex',
  TASKFORGE_OPENAI_API_KEY: 'sk-router',
  GEMINI_API_KEY: 'gem',
  GITHUB_TOKEN: 'ghp',
  AWS_SECRET_ACCESS_KEY: 'aws',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
};

function envFor(allow: string[]): Record<string, string> {
  return sanitizeEnvironment(PARENT_ENV, {}, { inherit: false, allow, denyPatterns: ['*PASSWORD*', '*SECRET*'] });
}

describe('agent credential isolation', () => {
  it('forwards only the Claude provider credentials to Claude Code', () => {
    const env = envFor(buildAgentEnvAllowlist(new ClaudeCodeAdapter()['providerEnvAllow']()));
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    for (const leaked of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'TASKFORGE_OPENAI_API_KEY']) {
      expect(env).not.toHaveProperty(leaked);
    }
  });

  it('forwards only the OpenAI credentials to Codex and Gemini credentials to Antigravity', () => {
    const codex = envFor(buildAgentEnvAllowlist(new CodexAdapter()['providerEnvAllow']()));
    expect(codex.OPENAI_API_KEY).toBe('sk-openai');
    expect(codex).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(codex).not.toHaveProperty('GEMINI_API_KEY');

    const agy = envFor(buildAgentEnvAllowlist(new AntigravityAdapter()['providerEnvAllow']()));
    expect(agy.GEMINI_API_KEY).toBe('gem');
    expect(agy).not.toHaveProperty('OPENAI_API_KEY');
    expect(agy).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('never forwards TaskForge router key, unrelated tokens or the SSH agent by default', () => {
    for (const adapter of [new ClaudeCodeAdapter(), new CodexAdapter(), new AntigravityAdapter(), new AiderAdapter()]) {
      const env = envFor(buildAgentEnvAllowlist(adapter['providerEnvAllow']()));
      expect(env).not.toHaveProperty('TASKFORGE_OPENAI_API_KEY');
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
      expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
      expect(env.PATH).toBe('/usr/bin');
    }
  });

  it('passEnv opts a variable in by name, but can never forward the router key', () => {
    const env = envFor(buildAgentEnvAllowlist([], ['SSH_AUTH_SOCK', 'TASKFORGE_OPENAI_API_KEY']));
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(env).not.toHaveProperty('TASKFORGE_OPENAI_API_KEY');
  });
});
