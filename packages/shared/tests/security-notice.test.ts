import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECURITY_NOTICE, shouldShowSecurityNotice, markSecurityNoticeShown } from '../src/security-notice.js';
import { getDefaultConfig, TaskForgeConfigSchema } from '../src/config.js';

describe('security notice', () => {
  let home: string;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-notice-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('says the three things a new person must know, in plain words', () => {
    const text = SECURITY_NOTICE.join('\n');
    expect(text).toContain('experimental');
    expect(text).toContain('container or VM');
    expect(text).toContain('no sandbox');
    expect(text).toContain('~/.ssh');
    expect(text).toContain('never applies changes to your branch on its own');
  });

  it('is shown until it has been shown once on this machine', () => {
    expect(shouldShowSecurityNotice()).toBe(true);
    markSecurityNoticeShown();
    expect(shouldShowSecurityNotice()).toBe(false);
    expect(fs.existsSync(path.join(home, '.taskforge', 'security-notice-shown'))).toBe(true);
  });
});

describe('default token budget', () => {
  it('is generous but not unlimited, and 0 turns the cap off', () => {
    expect(getDefaultConfig().execution.tokenBudget).toBe(2_000_000);
    const off = TaskForgeConfigSchema.parse({ execution: { tokenBudget: 0 } });
    expect(off.execution.tokenBudget).toBe(0);
    expect(() => TaskForgeConfigSchema.parse({ execution: { tokenBudget: -5 } })).toThrow();
  });
});
