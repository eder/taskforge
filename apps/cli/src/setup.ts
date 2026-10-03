/**
 * Guided first-time setup (`tf setup`): the checks, the project config and a
 * first small task in one flow, so a new person does not have to know that
 * doctor, init and a test run are three separate things. Every side effect is
 * injected, so the flow is testable without a terminal, agents or a repository.
 */
import { SECURITY_NOTICE } from '@taskforge/shared';

export interface SetupDeps {
  /** Called once the security notice was printed (so the first-launch notice is not repeated). */
  noticeShown?(): void;
  /** A person is at a terminal and can answer questions. */
  interactive: boolean;
  /** Accept the defaults without asking (also runs the test task). */
  yes: boolean;
  /** Offer the test task at all (`--no-smoke` turns it off). */
  smoke: boolean;
  isGitRepo(): Promise<boolean>;
  hasConfig(): boolean;
  /** Ids of agent CLIs that are installed and ready. */
  readyAgents(): Promise<string[]>;
  ask(question: string, defaultYes: boolean): Promise<boolean>;
  /** Runs another `tf` command in this process. */
  runCommand(args: string[]): Promise<void>;
  log(line: string): void;
}

export type SetupStepState = 'done' | 'skipped' | 'blocked';

export interface SetupOutcome {
  /** ready = nothing left to do; needs_attention = something above must be fixed first. */
  status: 'ready' | 'needs_attention';
  steps: Array<{ name: string; state: SetupStepState; note?: string }>;
}

/** Small, read-only and cheap: it proves an agent can work in this project. */
export const SETUP_SMOKE_PROMPT =
  'Describe this project in five short sentences: what it does, how it is organized, and how to run its tests. ' +
  'Read-only analysis: do not change any file.';
export const SETUP_SMOKE_BUDGET = '60k';

export async function runSetup(deps: SetupDeps): Promise<SetupOutcome> {
  const steps: SetupOutcome['steps'] = [];
  const { log } = deps;

  log('Before you start:');
  for (const line of SECURITY_NOTICE) log(`  • ${line}`);
  log('');
  deps.noticeShown?.();

  log('TaskForge setup: 3 steps (environment, project config, a small test task).\n');

  // 1. A repository is required; nothing else makes sense without one.
  log('1/3 Environment');
  if (!(await deps.isGitRepo())) {
    log('  ✖ This folder is not a git repository.');
    log('    Next: cd into your project (or run `git init` here), then run `tf setup` again.');
    steps.push({ name: 'environment', state: 'blocked', note: 'not a git repository' });
    return { status: 'needs_attention', steps };
  }
  await deps.runCommand(['doctor']);
  const agents = await deps.readyAgents();
  if (agents.length === 0) {
    log('  ✖ No coding agent is installed and ready.');
    log('    Next: install and sign in to at least one of Claude Code (`claude`), Codex (`codex`) or Antigravity (`agy`), then run `tf setup` again.');
    steps.push({ name: 'environment', state: 'blocked', note: 'no agent ready' });
  } else {
    log(`  ✔ Ready agents: ${agents.join(', ')}`);
    steps.push({ name: 'environment', state: 'done' });
  }

  // 2. Project config: how to verify changes in this project.
  log('\n2/3 Project config');
  if (deps.hasConfig()) {
    log('  ✔ .taskforge/config.yaml already exists.');
    steps.push({ name: 'config', state: 'done', note: 'already existed' });
  } else if (!deps.interactive && !deps.yes) {
    log('  – Skipped: no terminal to ask. Run `tf init --check`, or `tf setup --yes`.');
    steps.push({ name: 'config', state: 'skipped', note: 'no terminal' });
  } else if (
    deps.yes ||
    (await deps.ask(
      '  Create .taskforge/config.yaml? It tells TaskForge how to verify changes. This runs the detected test commands once to check they work, and shows the file before writing. [Y/n] ',
      true,
    ))
  ) {
    await deps.runCommand(['init', '--check', ...(deps.yes ? ['--yes'] : [])]);
    steps.push({ name: 'config', state: 'done' });
  } else {
    log('  – Skipped. TaskForge will use its defaults; `tf init` creates it later.');
    steps.push({ name: 'config', state: 'skipped', note: 'declined' });
  }

  // 3. A first small task, only when an agent can actually do it.
  log('\n3/3 Test task');
  if (!deps.smoke) {
    log('  – Skipped (--no-smoke).');
    steps.push({ name: 'test task', state: 'skipped', note: '--no-smoke' });
  } else if (agents.length === 0) {
    log('  – Skipped: no agent is ready (see step 1).');
    steps.push({ name: 'test task', state: 'blocked', note: 'no agent ready' });
  } else if (!deps.interactive && !deps.yes) {
    log('  – Skipped: no terminal to ask. `tf setup --yes` includes it.');
    steps.push({ name: 'test task', state: 'skipped', note: 'no terminal' });
  } else if (
    deps.yes ||
    (await deps.ask(
      `  Run a small read-only task now? It asks the team to describe this project, changes nothing, and is capped at ${SETUP_SMOKE_BUDGET} tokens. [Y/n] `,
      true,
    ))
  ) {
    await deps.runCommand(['run', SETUP_SMOKE_PROMPT, '--budget', SETUP_SMOKE_BUDGET]);
    steps.push({ name: 'test task', state: 'done' });
  } else {
    log('  – Skipped.');
    steps.push({ name: 'test task', state: 'skipped', note: 'declined' });
  }

  const blocked = steps.some((s) => s.state === 'blocked');
  log(
    blocked
      ? '\nSetup needs attention: fix the ✖ above, then run `tf setup` again.'
      : '\nYou are set. To prove the whole flow works here first, run `tf selftest`; then start with `tf` and describe what you want done.',
  );
  return { status: blocked ? 'needs_attention' : 'ready', steps };
}
