import { describe, it, expect } from 'vitest';
import { ProcessRunner } from '../src/process-runner.js';
import { sanitizeEnvironment } from '../src/env-sanitizer.js';

describe('Execution - Environment Sanitizer', () => {
  it('filters out sensitive variables and keeps allowlisted ones', () => {
    const parentEnv = {
      PATH: '/bin:/usr/bin',
      HOME: '/Users/test',
      MY_SECRET_TOKEN: 'super-secret',
      API_PASSWORD_HASH: 'xyz',
      SAFE_VAR: 'not-in-allowlist',
    };

    const sanitized = sanitizeEnvironment(parentEnv, { CUSTOM_VAR: '123' });
    expect(sanitized.PATH).toBe('/bin:/usr/bin');
    expect(sanitized.HOME).toBe('/Users/test');
    expect(sanitized.CUSTOM_VAR).toBe('123');
    expect(sanitized.MY_SECRET_TOKEN).toBeUndefined();
    expect(sanitized.API_PASSWORD_HASH).toBeUndefined();
    expect(sanitized.SAFE_VAR).toBeUndefined();
  });

  it('preserves explicitly allowlisted tokens even when denyPatterns contains *TOKEN*', () => {
    const parentEnv = {
      PATH: '/bin:/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-token',
      OTHER_SECRET_TOKEN: 'forbidden-token',
    };

    const sanitized = sanitizeEnvironment(
      parentEnv,
      {},
      {
        inherit: false,
        allow: ['PATH', 'CLAUDE_CODE_OAUTH_TOKEN'],
        denyPatterns: ['*PASSWORD*', '*SECRET*', '*TOKEN*'],
      },
    );

    expect(sanitized.PATH).toBe('/bin:/usr/bin');
    expect(sanitized.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-test-token');
    expect(sanitized.OTHER_SECRET_TOKEN).toBeUndefined();
  });
});

describe('Execution - ProcessRunner', () => {
  it('executes a command and captures stdout', async () => {
    const result = await ProcessRunner.run({
      command: 'node',
      args: ['-e', 'console.log("hello taskforge"); process.stdout.write("more");'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello taskforge');
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it('handles command timeouts cleanly', async () => {
    const result = await ProcessRunner.run({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000);'],
      timeoutMs: 150,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('handles cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await ProcessRunner.run({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000);'],
      abortSignal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
  });
});
