# Changelog

All notable changes to TaskForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).
All workspace packages are released in lockstep under a single version.

## [Unreleased]

### Added
- `tf abandon <run-id>` closes a failed, cancelled or interrupted run you no longer want (for example because you applied the change by hand). It is ignored by `tf resume`, shown as ABANDONED in `tf runs`, and nothing is deleted. Completed runs are refused.
- `tf resume` warns when the repository has moved on since the run started ("started from abc1234 ... moved on by N commits"), and points to `tf abandon` for work already applied by hand.
- **Blocked work is kept and reused.** When a task is blocked after agents produced a change, the change is kept on `taskforge/candidate/<run>/<task>` (and recorded in the run), the report names the branch, and `tf resume` reuses it: if the blocker was verification configuration, the environment or a policy, only the checks run again with **no agent call**; if the work itself was wrong, the agent continues from the kept commit with the recorded evidence. `tf resume --fresh` discards it. Previously the work was left on an unreferenced commit and resuming restarted the task from scratch (the run that exposed this cost 843k tokens and could not be finished).
- `tf init [--print] [--check] [--yes] [--force]`: proposes a project `.taskforge/config.yaml` from what it detects (Node, Python and its virtualenv, Go, Rust, Swift, Makefile), shows it, and only writes after confirmation; never overwrites. `--check` runs each detected command once and reports whether it works.
- Starting `tf` in a project without a config prints a one-time notice that the file is optional and how to create it (`TASKFORGE_NO_HINTS=1` disables it); `tf doctor` shows whether a project config exists.
- Docs: "Do I need `.taskforge/config.yaml`?" in `docs/usage.md`.
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
- **`tf` run from a sub-folder used a new, empty `.taskforge/`.** Config, database, runs and worktrees were all relative to the current directory, so `tf resume` in `repo/server` answered "Nothing to resume" (it was looking at an empty database), ignored `repo/.taskforge/config.yaml`, and left a stray `.taskforge/` inside the sub-folder. The CLI now works from the project root (nearest enclosing git repository, or an existing `.taskforge/`, never the home directory) and says so on stderr when that differs from the current directory. `TASKFORGE_PROJECT_ROOT` overrides it.
- Completion-gate rejections were shown as bare codes (`NO_CHANGES_PRODUCED`). They are now plain sentences ("The agent finished without changing any file, but this task requires a change. The work may already exist ..."), including for runs recorded earlier.
- A verification command that does not suit the project (pytest without an asyncio plugin, "no tests ran", "file or directory not found", exit code 126/127, unrecognized arguments) is now classified as a verification-configuration problem instead of a code failure, so it blocks immediately without retrying agents.
- The "Why the run did not complete" report summarizes a failed check (headline plus first output line) instead of dumping the command and output on one line, and says when the agents' work was kept.
- **`tf init` proposed `pytest` for projects whose tests are scripts** (`python test_x.py`, e.g. asyncio scripts), which fails immediately, so the first code task was BLOCKED by verification. It now recognizes script-style suites and proposes a loop over the scripts; `tf init --check` runs each script on its own (per-file limit) and keeps only those that pass in this environment, listing the others as comments with the reason (typically they need a database, server or audio). The multi-line command is written as a YAML block.
- A failed verification check reported only `Check 'explicit-1' failed with exit code 2`. It now includes the command and the last lines of output (and "timed out" when applicable), in the progress line, the run summary and the retry evidence given to the agent.
- When the model planner was not used, the plan said only `Deterministic decomposition (model_unresponsive_or_invalid)`. It now adds the cause (HTTP status and the provider's message, timeout, or why the plan was rejected).
- **A failed run did not say which task failed or why.** The team execution path ended a task as failed/blocked without printing or recording anything, and the end-of-run summary only showed "Tasks failed: 1". Every failure site now records a durable `TASK_FAILED` reason, the team path prints `Team execution failed: <reason>`, and a new "Why the run did not complete" report (end-of-run summary in the REPL, `tf run`/`exec`/`resume`, and `tf inspect`) lists each failed or blocked task with its recorded reason, the tasks that never started and what they were waiting for, and the next command (`tf resume` / `tf inspect`).
- **Natural read-only requests were classified as implementation.** "veja o que falta ser feito" matched no read-only verb and fell through to `IMPLEMENTATION`, which asked for approval, planned three sequential investigations and spent 661k tokens in 7 minutes. The read/inspect vocabulary (veja, confira, verifique, liste, mostre, levante, "o que falta", "what's left", ...) now classifies as read-only, and unambiguous change imperatives (faça, ajuste, altere, instale, aplique, deploy, ...) keep a request an implementation even if it starts with a read verb.
- `tf init --check` printed nothing while the command ran and allowed 10 minutes, so a slow or stuck test command looked like a hang. It now shows the first output lines live, a heartbeat every 10s, stops after `--check-timeout` seconds (default 120), stops on Ctrl-C without writing anything, closes stdin, and on failure shows the last lines plus a specific tip for common causes (such as asyncio script-style tests run under `pytest`).
- `tf runs` listed `Branch:` and `Apply: tf apply <id>` for every run, including failed, cancelled and read-only ones that have nothing to deliver, and printed the whole goal (a multi-hundred-line prompt filled the screen). It now reads the delivery state like the REPL's `/runs`: applied (with commit), PR opened, discarded, or ready to apply; failed/cancelled runs point to `tf resume`; goals are summarized to their first line; the 10-run cap is stated.
- `tf resume` without an id picked the newest failed/cancelled run even when it could not be resumed (for example a run from before resume checkpoints existed) and stopped with "no recorded base commit". It now skips runs that cannot be continued, resumes the newest one that can, and, when none can, lists each run with the reason (or says there is nothing to resume). The explicit-id error now explains the cause and what to do.
- The "No verification checks were executed" block message now says that TaskForge only discovers Node checks and names the file, key and `tf init`, instead of the vague "provide verification configuration".
- A change that only touches documentation (`.md`, `.txt`, `.rst`, ... or LICENSE/README-style files) is no longer BLOCKED for lack of verification commands, per task and in the final integration check. Anything that touches code or config still fails closed, and explicitly configured verification commands still run and must pass.
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
