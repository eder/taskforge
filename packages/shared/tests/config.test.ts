import { describe, it, expect } from 'vitest';
import { getDefaultConfig, TaskForgeConfigSchema } from '../src/config.js';
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

  it('validates custom config overrides', () => {
    const custom = TaskForgeConfigSchema.parse({
      execution: { maxParallelTasks: 5 },
      router: { provider: 'static' },
    });
    expect(custom.execution.maxParallelTasks).toBe(5);
    expect(custom.router.provider).toBe('static');
    expect(custom.verification.lint).toBe(true); // defaults retained
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
});
