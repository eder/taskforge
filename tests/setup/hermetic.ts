/**
 * Makes every test independent of the developer's machine.
 *
 * Without this, tests behave differently when real agent CLIs (claude, codex,
 * agy, ...) are installed, when an OpenAI key is exported, or when
 * ~/.taskforge holds global config/state: real agents get detected, the
 * router calls the network, and quota state leaks between runs. CI has none
 * of those, so the suite must not depend on them locally either.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Opt-in suites that deliberately exercise real agent CLIs (see
// packages/agents/tests/real-adapters-hardening.test.ts) must see the real
// environment, so isolation is skipped when any of these flags is set.
const REAL_AGENT_FLAGS = [
  'TASKFORGE_TEST_REAL_AGENTS',
  'TASKFORGE_TEST_CLAUDE',
  'TASKFORGE_TEST_CODEX',
  'TASKFORGE_TEST_AGY',
];
const wantsRealAgents = REAL_AGENT_FLAGS.some((flag) => process.env[flag] === '1');

const AGENT_BINARIES = ['claude', 'codex', 'agy', 'cursor-agent', 'aider', 'opencode', 'goose'];
const SECRET_ENV = ['TASKFORGE_OPENAI_API_KEY', 'OPENAI_API_KEY'];

function isolate(): void {
  for (const key of SECRET_ENV) delete process.env[key];

  // Fresh HOME: no global ~/.taskforge config or persisted agent-quota state.
  const home = mkdtempSync(path.join(tmpdir(), 'taskforge-test-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // HOME no longer provides a git identity, so supply one explicitly.
  process.env.GIT_AUTHOR_NAME ??= 'TaskForge Test';
  process.env.GIT_AUTHOR_EMAIL ??= 'test@taskforge.dev';
  process.env.GIT_COMMITTER_NAME ??= 'TaskForge Test';
  process.env.GIT_COMMITTER_EMAIL ??= 'test@taskforge.dev';

  // Hide real agent CLIs from `which`: drop PATH entries that contain one,
  // but always keep the directories of node and git.
  const original = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const hasAgent = (dir: string) => AGENT_BINARIES.some((bin) => existsSync(path.join(dir, bin)));
  const keep = new Set(original.filter((dir) => !hasAgent(dir)));
  keep.add(path.dirname(process.execPath));
  try {
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    if (gitPath) keep.add(path.dirname(gitPath));
  } catch {
    // git not found on PATH; nothing to add
  }
  process.env.PATH = [...keep].join(path.delimiter);
}

if (!wantsRealAgents) isolate();
