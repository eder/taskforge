# Changelog

All notable changes to TaskForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).
All workspace packages are released in lockstep under a single version.

## [Unreleased]

### Added
- `tf resume [run-id]` / `RunOrchestrator.resume()`: continue an interrupted, cancelled or failed run, keeping tasks already integrated into the run branch. Runs now checkpoint their goal, base commit, base branch, task dependencies and task outputs.
- Human-readable delivery branch for pull requests (`taskforge/<goal-slug>`) via `DeliveryService.prepareDeliveryBranch()` and `slugifyGoal()`.
- `tf cleanup --prune --older-than <age> [--dry-run]` and opt-in `execution.autoPruneOlderThan` for age-based cleanup of stale worktrees and temporary branches.
- Release tooling: lockstep versioning scripts, release verification, and a tag-driven release workflow with npm provenance.
- `SECURITY.md`, `CONTRIBUTING.md`, issue and pull-request templates.
- Opt-in dual-review gate (`verification.dualReview`): sensitive tasks need an independent agent's explicit approval before integration; fails closed.
- Experimental opt-in adapters for Cursor CLI, Aider, OpenCode and Goose (register them under `agents` in config).
- Test coverage reporting in CI (`pnpm test:coverage`) with a regression floor.

- Plans show an approximate **Estimated usage** token range before approval.
- `verification.enforceScope` (default on): tasks that modify files outside their `allowedScope` fail and retry with the offending files as evidence.
- `agents.<id>.passEnv` to forward extra environment variables to a single agent.
- `docs/pilot.md`: checklist to validate TaskForge with real agents.
- Hermetic test setup (`tests/setup/hermetic.ts`): tests no longer depend on installed agent CLIs, exported API keys, or `~/.taskforge`.

### Fixed
- **Antigravity (`agy`) output was always empty.** The adapter only recognised `{"type":"result"}`, but `agy` emits `{"event":"result","result":{"response":...}}`, so every Antigravity assignment returned no report (checked against a real captured run). The result event, its nested status, and the per-step `text_delta` fallback are now parsed.
- `IntegrationService` cached the first run's integration branch for every later run on the same instance; it is now per run and re-validated against git. `tf resume` also removes a stale integration worktree when the run branch is gone.
- `tf resume` discarded finished read-only report tasks when the run branch did not exist (report-only runs never create it) and re-ran them, wasting provider tokens. Runs now record which tasks integrated commits; only those are redone if the branch is gone. Older runs fall back to the task contract. The resume message lists the kept and pending tasks.
- **OpenAI routing never worked:** the routing JSON schema listed `roles[].preferredAgent` in `properties` but not in `required`, which OpenAI strict structured outputs reject with HTTP 400, so every route silently fell back to the static router. The property is now required and nullable. The fallback detail also shows the provider's error message instead of a bare "HTTP 400". A new test checks every strict schema offline.
- **An implementation task could be staffed with no implementer** and fail only at execution time, after earlier tasks had spent ~700k tokens. The static router matched keywords as substrings (`trace` → race, `author` → auth, `debug` → bug, `investigação` → investigation) and downgraded a mutating task to a read-only investigation team. Keywords now match whole words, and the quality guard adds an implementer to any mutating task for every router (static, OpenAI, adaptive) before anything runs.
- A parallel investigator that exits successfully with an empty report was counted as evidence ("useful"). It now counts as a failed role under the investigation policy.
- The pre-approval usage estimate was an order of magnitude too low for real agents (≈24k estimated vs ≈310k fresh tokens used). Bands are rescaled, the calibration clamp is widened so history can correct it, and the line states that it estimates fresh tokens only.
- **Data loss:** every run numbers its tasks `TASK-01`, `TASK-02`, ... but task rows are keyed by id alone, so a second run overwrote the first run's tasks and cascade-deleted its assignments (history lost; `tf resume` of the earlier run failed). Task ids are now renumbered when they clash with an earlier run.
- Two TaskForge processes starting together on one repository failed with `database is locked` (journal-mode switch and schema creation are now retried). Run and goal ids could also collide when started in the same millisecond.
- The REPL ignored the `agents:` section of the config (`command`, `args`, `env`, `passEnv`, `enabled`, opt-in adapters); only headless runs honored it.
- Invalid configuration now prints a short, readable error (field and reason) instead of a stack trace, and the `node:sqlite` experimental warning no longer prints before every command.
- `tf pr create <run-id>` treated `create` as the run id (broken argument parsing).
- `/pr` never pushed the branch, so `gh pr create` failed in real repositories. It now pushes (never forced) using your own git/gh credentials.
- Pull request bodies hard-coded "Tests/Lint/Typecheck: PASS". They now list the checks that actually ran, with failures, or say that none were recorded.
- Repositories whose trunk is `master` (or any branch other than the configured `main`) could not `/apply`: the target branch is now reconciled with the branches that exist, and a missing target gives a clear error.
- Ctrl-C during `tf run`, `tf resume` and `tf exec` killed the process abruptly, orphaning agents and leaving the run `running`. It now stops agents gracefully, marks the run cancelled and suggests `tf resume`; a second Ctrl-C forces exit.
- Verification failed in every worktree of a Node project because dependencies were missing: `node_modules` is now linked into worktrees (`execution.worktreeLinks`).
- Verification commands were split on spaces (no quotes, `&&`, `VAR=1`), ran with a minimal environment, and had a fixed 60s timeout. They now run via the shell, inherit your environment (minus secrets), and honor `verification.commandTimeoutSeconds` (default 600).
- Starting or closing the REPL wiped every TaskForge worktree and temporary branch, breaking another live session in the same repository. Housekeeping now only removes artifacts older than 12h.
- `.taskforge/` showed up as untracked in the user's repository and could be committed by accident. It is now excluded through `.git/info/exclude`.
- A task completed after a recovery retry could fail to integrate: the retry's commit only holds the delta against the previous candidate and conflicted when cherry-picked alone. The attempt chain is now integrated as one commit.
- `tf cleanup` (and orphan cleanup) removed every linked git worktree in the repository, including ones the user created. They now only touch worktrees under the configured TaskForge worktrees directory.
- Agents received every provider's credentials plus TaskForge's own router key and `SSH_AUTH_SOCK`. Each agent now gets only its provider's variables (**breaking** for setups that relied on an agent using SSH agent forwarding; use `passEnv`).

### Changed
- `agents.<id>.enabled: false` is now honored for every harness.
- Large modules were split without API changes: `@taskforge/persistence` repositories, `@taskforge/agents` adapters, and the REPL's pure helpers/formatters.
- The CLI and REPL banner read the version from a single source (`TASKFORGE_VERSION`).
- Packages declare npm publish metadata (`files`, `license`, `repository`, `publishConfig`).

## [0.1.0]

Initial development version: planner, router, deterministic scheduler, isolated git worktrees, interaction gateway, completion gate and verification, bounded recovery, and explicit delivery (`/diff`, `/apply`, `/pr`).
