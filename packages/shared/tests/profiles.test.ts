import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, getDefaultConfig, EXECUTION_PROFILES } from '../src/config.js';

describe('execution profiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-profile-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (yaml: string) => {
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, yaml);
    return file;
  };

  it('a project with no settings gets economy: one agent per task and a 1M cap', () => {
    const config = loadConfig(write('version: 1\n'));
    expect(config.execution.profile).toBe('economy');
    expect(config.collaboration.maxAgentsPerTask).toBe(1);
    expect(config.execution.tokenBudget).toBe(1_000_000);
  });

  it('standard and thorough raise both', () => {
    const standard = loadConfig(write('execution:\n  profile: standard\n'));
    expect([standard.collaboration.maxAgentsPerTask, standard.execution.tokenBudget]).toEqual([2, 2_000_000]);
    const thorough = loadConfig(write('execution:\n  profile: thorough\n'));
    expect([thorough.collaboration.maxAgentsPerTask, thorough.execution.tokenBudget]).toEqual([3, 4_000_000]);
  });

  it('anything set explicitly wins over the profile', () => {
    const config = loadConfig(write('execution:\n  profile: economy\n  tokenBudget: 0\ncollaboration:\n  maxAgentsPerTask: 3\n'));
    expect(config.execution.tokenBudget).toBe(0);
    expect(config.collaboration.maxAgentsPerTask).toBe(3);
  });

  it('a misspelt profile is rejected with a clear message instead of being silently ignored', () => {
    expect(() => loadConfig(write('execution:\n  profile: ludicrous\n'))).toThrow(/profile/);
  });

  it('the built-in defaults used by tests are unchanged, and the profile table matches the docs', () => {
    expect(getDefaultConfig().collaboration.maxAgentsPerTask).toBe(3);
    expect(getDefaultConfig().execution.tokenBudget).toBe(2_000_000);
    expect(EXECUTION_PROFILES.economy).toEqual({ maxAgentsPerTask: 1, tokenBudget: 1_000_000 });
  });
});
