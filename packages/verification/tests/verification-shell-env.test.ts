import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '@taskforge/shared';
import { VerificationRunner, verificationEnvPolicy } from '../src/verification-runner.js';

describe('VerificationRunner shell execution and environment', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verify-'));
    for (const k of ['DATABASE_URL', 'STRIPE_API_KEY', 'TASKFORGE_OPENAI_API_KEY']) saved[k] = process.env[k];
    process.env.DATABASE_URL = 'postgres://localhost/test';
    process.env.STRIPE_API_KEY = 'sk_test_123';
    process.env.TASKFORGE_OPENAI_API_KEY = 'sk-router';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (commands: string[], patch: (c: ReturnType<typeof getDefaultConfig>) => void = () => {}) => {
    const config = getDefaultConfig();
    patch(config);
    return new VerificationRunner().verify({
      taskId: 'T',
      runId: 'R',
      worktreePath: dir,
      config,
      explicitCommands: commands,
    });
  };

  it('supports quotes, &&, pipes and VAR=1 prefixes (shell syntax)', async () => {
    const result = await run([
      'echo "two words" | grep -q "two words" && echo ok',
      'FOO=1 sh -c \'test "$FOO" = 1\'',
    ]);
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2);
  });

  it('fails when a command in an && chain fails', async () => {
    const result = await run(['true && false']);
    expect(result.passed).toBe(false);
  });

  it('gives tests the normal environment but withholds secret-looking names and the router key', async () => {
    const result = await run([
      'test "$DATABASE_URL" = "postgres://localhost/test"',
      'test -z "$STRIPE_API_KEY"',
      'test -z "$TASKFORGE_OPENAI_API_KEY"',
    ]);
    expect(result.checks.map((c) => c.success)).toEqual([true, true, true]);
  });

  it('forwards secret-looking names only when listed in verification.passEnv', async () => {
    const result = await run(['test "$STRIPE_API_KEY" = "sk_test_123"', 'test -z "$TASKFORGE_OPENAI_API_KEY"'], (c) => {
      c.verification.passEnv = ['STRIPE_API_KEY', 'TASKFORGE_OPENAI_API_KEY'];
    });
    expect(result.checks[0].success).toBe(true);
    // The router key is blocked by name even if explicitly requested.
    expect(result.checks[1].success).toBe(true);
    expect(verificationEnvPolicy(['TASKFORGE_OPENAI_API_KEY']).allow).not.toContain('TASKFORGE_OPENAI_API_KEY');
  });

  it('honors verification.commandTimeoutSeconds instead of a fixed 60s', async () => {
    const started = Date.now();
    const result = await run(['sleep 5'], (c) => {
      c.verification.commandTimeoutSeconds = 1;
    });
    expect(result.passed).toBe(false);
    expect(Date.now() - started).toBeLessThan(4500);
  });
});
