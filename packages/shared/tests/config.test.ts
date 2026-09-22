import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  getDefaultConfig,
  TaskForgeConfigSchema,
  getGlobalStateDatabasePath,
} from '../src/config.js';
import { ConfigurationError, TaskForgeError } from '../src/errors.js';

describe('Shared - Config', () => {
  it('loads default config successfully', () => {
    const config = getDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.execution.maxParallelTasks).toBe(3);
    expect(config.agents.claude.enabled).toBe(true);
    expect(config.agents.codex.maxParallel).toBe(2);
    expect(config.verification.tests).toBe(true);
  });

  it('validates custom config overrides including router.apiKey', () => {
    const custom = TaskForgeConfigSchema.parse({
      execution: { maxParallelTasks: 5 },
      router: { provider: 'openai', apiKey: 'sk-custom-key' },
    });
    expect(custom.execution.maxParallelTasks).toBe(5);
    expect(custom.router.provider).toBe('openai');
    expect(custom.router.apiKey).toBe('sk-custom-key');
    expect(custom.verification.lint).toBe(true); // defaults retained
  });

  it('resolveOpenAIApiKey prioritizes TASKFORGE_OPENAI_API_KEY over config and OPENAI_API_KEY', async () => {
    const { resolveOpenAIApiKey } = await import('../src/config.js');
    const origTaskforge = process.env.TASKFORGE_OPENAI_API_KEY;
    const origOpenai = process.env.OPENAI_API_KEY;

    try {
      process.env.TASKFORGE_OPENAI_API_KEY = 'sk-taskforge-priority';
      process.env.OPENAI_API_KEY = 'sk-generic-fallback';
      const configWithKey = TaskForgeConfigSchema.parse({
        router: { apiKey: 'sk-config-key' },
      });

      // 1. TASKFORGE_OPENAI_API_KEY wins over config and OPENAI_API_KEY
      expect(resolveOpenAIApiKey(configWithKey)).toBe('sk-taskforge-priority');

      // 2. config.router.apiKey wins over OPENAI_API_KEY when TASKFORGE_OPENAI_API_KEY is unset
      delete process.env.TASKFORGE_OPENAI_API_KEY;
      expect(resolveOpenAIApiKey(configWithKey)).toBe('sk-config-key');

      // 3. OPENAI_API_KEY is used as final fallback
      const configWithoutKey = TaskForgeConfigSchema.parse({});
      expect(resolveOpenAIApiKey(configWithoutKey)).toBe('sk-generic-fallback');

      // 4. Undefined when nothing is set
      delete process.env.OPENAI_API_KEY;
      expect(resolveOpenAIApiKey(configWithoutKey)).toBeUndefined();
    } finally {
      if (origTaskforge !== undefined) process.env.TASKFORGE_OPENAI_API_KEY = origTaskforge;
      else delete process.env.TASKFORGE_OPENAI_API_KEY;

      if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai;
      else delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('Shared - Errors', () => {
  it('creates typed errors with code and context', () => {
    const error = new ConfigurationError('Invalid configuration', { key: 'foo' });
    expect(error).toBeInstanceOf(TaskForgeError);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(error.message).toBe('Invalid configuration');
    expect(error.context).toEqual({ key: 'foo' });
  });

  it('stores provider availability in a global user-level database', () => {
    expect(getGlobalStateDatabasePath()).toBe(
      path.resolve(os.homedir(), '.taskforge/state.db'),
    );
    expect(path.isAbsolute(getGlobalStateDatabasePath())).toBe(true);
  });
});
