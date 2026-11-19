import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDefaultConfig,
  loadConfig,
  EXECUTION_PROFILES,
  TaskForgeConfigSchema,
  getGlobalStateDatabasePath,
  resolveOpenAIBaseUrl,
  resolveOpenAIApiKey,
  normalizeOpenAIBaseUrl,
} from '../src/config.js';
import { ConfigurationError, TaskForgeError } from '../src/errors.js';
import { parseTokenCount } from '../src/token-count.js';
import { setProjectConfigValue } from '../src/project-config-patch.js';
import {
  SECURITY_NOTICE,
  shouldShowSecurityNotice,
  markSecurityNoticeShown,
} from '../src/security-notice.js';

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

  it('normalizes gateway endpoints and rejects credential-bearing URLs', () => {
    expect(normalizeOpenAIBaseUrl('http://localhost:3001/v1/')).toBe('http://localhost:3001/v1');
    expect(() => normalizeOpenAIBaseUrl('ftp://localhost/v1')).toThrow();
    expect(() => normalizeOpenAIBaseUrl('https://u:p@example.com/v1')).toThrow();
    expect(() => normalizeOpenAIBaseUrl('https://example.com/v1?key=x')).toThrow();
  });

  it('uses a configured gateway URL and isolates the global OpenAI API key', () => {
    const beforeUrl = process.env.TASKFORGE_OPENAI_BASE_URL;
    const beforeDedicatedKey = process.env.TASKFORGE_OPENAI_API_KEY;
    const beforeGlobalKey = process.env.OPENAI_API_KEY;
    try {
      delete process.env.TASKFORGE_OPENAI_BASE_URL;
      delete process.env.TASKFORGE_OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-global-should-not-leak';
      const config = TaskForgeConfigSchema.parse({
        router: { baseUrl: 'http://localhost:3001/v1', model: 'auto' },
      });
      expect(resolveOpenAIBaseUrl(config)).toBe('http://localhost:3001/v1');
      expect(resolveOpenAIApiKey(config)).toBeUndefined();
      process.env.TASKFORGE_OPENAI_API_KEY = 'freellmapi-dedicated-key';
      expect(resolveOpenAIApiKey(config)).toBe('freellmapi-dedicated-key');
      process.env.TASKFORGE_OPENAI_BASE_URL = 'http://127.0.0.1:3210/v1/';
      expect(resolveOpenAIBaseUrl(config)).toBe('http://127.0.0.1:3210/v1');
    } finally {
      if (beforeUrl === undefined) delete process.env.TASKFORGE_OPENAI_BASE_URL;
      else process.env.TASKFORGE_OPENAI_BASE_URL = beforeUrl;
      if (beforeDedicatedKey === undefined) delete process.env.TASKFORGE_OPENAI_API_KEY;
      else process.env.TASKFORGE_OPENAI_API_KEY = beforeDedicatedKey;
      if (beforeGlobalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = beforeGlobalKey;
    }
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

describe('parseTokenCount', () => {
  it('reads plain numbers and k/m suffixes', () => {
    expect(parseTokenCount('500000')).toBe(500000);
    expect(parseTokenCount('500k')).toBe(500000);
    expect(parseTokenCount('1.5m')).toBe(1500000);
    expect(parseTokenCount('1,200,000')).toBe(1200000);
    expect(parseTokenCount(250000)).toBe(250000);
  });

  it('rejects anything that is not a positive amount', () => {
    for (const bad of ['', 'abc', '-5', '0', '0k', '12x', '1.2.3']) {
      expect(parseTokenCount(bad)).toBeUndefined();
    }
    expect(parseTokenCount(1.5)).toBeUndefined();
    expect(parseTokenCount(undefined)).toBeUndefined();
  });
});

describe('setProjectConfigValue', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-patch-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the file when there is none and leaves no temporary file behind', () => {
    const { file } = setProjectConfigValue(dir, ['git', 'workflow'], 'gitflow');
    expect(fs.readFileSync(file, 'utf8')).toContain('workflow: gitflow');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['config.yaml']);
  });

  it('changes only the named key while preserving comments', () => {
    const file = path.join(dir, '.taskforge', 'config.yaml');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'git:\n  workflow: trunk # default\n  targetBranch: main\n');
    setProjectConfigValue(dir, ['git', 'workflow'], 'gitflow');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'git:\n  workflow: gitflow # default\n  targetBranch: main\n',
    );
  });
});

describe('execution profiles and token budget', () => {
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

  it('standard and thorough raise both, and explicit overrides win', () => {
    const standard = loadConfig(write('execution:\n  profile: standard\n'));
    expect([standard.collaboration.maxAgentsPerTask, standard.execution.tokenBudget]).toEqual([2, 2_000_000]);
    const thorough = loadConfig(write('execution:\n  profile: thorough\n'));
    expect([thorough.collaboration.maxAgentsPerTask, thorough.execution.tokenBudget]).toEqual([3, 4_000_000]);
    const override = loadConfig(
      write('execution:\n  profile: economy\n  tokenBudget: 0\ncollaboration:\n  maxAgentsPerTask: 3\n'),
    );
    expect(override.execution.tokenBudget).toBe(0);
    expect(override.collaboration.maxAgentsPerTask).toBe(3);
  });

  it('rejects invalid profiles and negative token budgets', () => {
    expect(() => loadConfig(write('execution:\n  profile: ludicrous\n'))).toThrow(/profile/);
    expect(getDefaultConfig().collaboration.maxAgentsPerTask).toBe(3);
    expect(getDefaultConfig().execution.tokenBudget).toBe(2_000_000);
    expect(EXECUTION_PROFILES.economy).toEqual({ maxAgentsPerTask: 1, tokenBudget: 1_000_000 });
    expect(TaskForgeConfigSchema.parse({ execution: { tokenBudget: 0 } }).execution.tokenBudget).toBe(0);
    expect(() => TaskForgeConfigSchema.parse({ execution: { tokenBudget: -5 } })).toThrow();
  });
});

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

  it('states the key safety boundaries and records first-run dismissal', () => {
    const text = SECURITY_NOTICE.join('\n');
    expect(text).toContain('experimental');
    expect(text).toContain('container or VM');
    expect(text).toContain('no sandbox');
    expect(text).toContain('~/.ssh');
    expect(text).toContain('never applies changes to your branch on its own');

    expect(shouldShowSecurityNotice()).toBe(true);
    markSecurityNoticeShown();
    expect(shouldShowSecurityNotice()).toBe(false);
    expect(fs.existsSync(path.join(home, '.taskforge', 'security-notice-shown'))).toBe(true);
  });
});
