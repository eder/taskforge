import { describe, it, expect } from 'vitest';
import { runCheckCommand, tipForFailure } from '../src/project-check.js';

const base = { cwd: process.cwd(), timeoutSeconds: 10 };

describe('runCheckCommand', () => {
  it('reports a passing command and streams its output', async () => {
    const chunks: string[] = [];
    const result = await runCheckCommand('echo hello && echo world', { ...base, onOutput: (c) => chunks.push(c) });
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toContain('hello');
    expect(result.tail).toEqual(['hello', 'world']);
  });

  it('reports a failing command with its last lines', async () => {
    const result = await runCheckCommand('echo one; echo boom >&2; exit 3', base);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.tail).toContain('boom');
  });

  it('stops a command that exceeds the limit and says so (instead of hanging for minutes)', async () => {
    const started = Date.now();
    const result = await runCheckCommand('sleep 30', { cwd: base.cwd, timeoutSeconds: 1 });
    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await runCheckCommand('sleep 30', { ...base, signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('closes stdin, so a command waiting for input fails fast instead of hanging', async () => {
    const started = Date.now();
    const result = await runCheckCommand('read line; echo got:$line', { ...base, timeoutSeconds: 20 });
    expect(result.status).toBe('passed'); // read returns immediately on a closed stdin
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('emits a heartbeat while a slow command runs', async () => {
    const beats: number[] = [];
    await runCheckCommand('sleep 2.5', { ...base, heartbeatSeconds: 1, onHeartbeat: (s) => beats.push(s) });
    expect(beats.length).toBeGreaterThanOrEqual(1);
  });

  it('does not expose secret-looking environment variables to the command', async () => {
    process.env.TF_CHECK_SECRET_API_KEY = 'hunter2';
    try {
      const result = await runCheckCommand('test -z "$TF_CHECK_SECRET_API_KEY"', base);
      expect(result.status).toBe('passed');
    } finally {
      delete process.env.TF_CHECK_SECRET_API_KEY;
    }
  });
});

describe('tipForFailure', () => {
  it('recognizes asyncio script-style tests run under pytest (the zaira case)', () => {
    const output = 'FAILED test_x.py::test_a - Failed: async def functions are not natively supported.';
    expect(tipForFailure('cd server && .venv/bin/python -m pytest -q', output)).toContain('asyncio scripts');
  });

  it('recognizes a missing dependency, a missing virtualenv and a missing service', () => {
    expect(tipForFailure('python -m pytest', 'No module named pytest')).toContain('dependency');
    expect(tipForFailure('.venv/bin/python x.py', 'sh: .venv/bin/python: No such file or directory')).toContain('virtualenv');
    expect(tipForFailure('pytest', 'ECONNREFUSED 127.0.0.1:5432')).toContain('running service');
  });

  it('gives no tip for an unknown failure', () => {
    expect(tipForFailure('make test', 'assertion failed')).toBeUndefined();
  });
});
