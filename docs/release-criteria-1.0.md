# Criteria for TaskForge 1.0

1.0 is a promise, not a feature list: from 1.0 on, what is listed under **Compatibility** does not break in a minor release. Everything under **Not required** may ship before or after.

Numbers marked *(proposed)* are starting points for the maintainer to confirm or change; they are not measured facts.

## 1. Evidence from real use

All of these are recorded in [`docs/pilot.md`](pilot.md) for the release candidate itself:

- Steps 1-7 pass with at least two different agents, and no step produced an unreviewed change on the base branch.
- Step 9 (parallelism, time, tokens) is filled in for at least 3 multi-area tasks, with at least two different agents. 1.0 should not be tagged on test counts alone: the product claim is several agents working at once, cheaper and faster than one, so there must be numbers showing it (parallelism clearly above 1.0 on tasks that can be split, and tokens in the range of the plan's estimate *(proposed: within 2x)*).
- `tf selftest` passes on macOS and on the Linux CI image.
- The container image (`Dockerfile`) was built and used for a full pilot run by someone other than its author.

## 2. Compatibility (the contract from 1.0)

| Surface | Promise from 1.0 |
| --- | --- |
| `.taskforge/config.yaml` | Existing keys keep their meaning and defaults. New keys are optional. A key is removed only after one minor release in which it still works and warns. |
| SQLite state (`.taskforge/taskforge.db`, `~/.taskforge/state.db`) | Every 1.x opens a database written by any earlier 1.x, upgrading it in place through versioned migrations (`PRAGMA user_version`). A database from a newer version is refused untouched. No migration deletes data without an explicit command. |
| CLI commands and flags (`tf ...`) and REPL slash commands | Names and documented flags keep working; removals follow the same one-minor deprecation. Human-readable output is not part of the promise. |
| `--json` outputs (for example `tf insights --json`) | Fields are added, not renamed or removed. |
| Event types in the audit trail | Existing types keep their meaning; new ones may appear. |

Explicitly **outside** the promise: experimental adapters (Cursor, Aider, OpenCode, Goose, `DockerWorkerAdapter`, `SshWorkerAdapter`), anything the docs call experimental, and Windows.

## 3. Security and safety

- `SECURITY.md` describes what is and is not enforced, matching the code at the release commit.
- The container mode is the documented way to run untrusted work, and `tf doctor` reports whether it is in use.
- No open report that shows model output controlling permissions, process lifecycles, Git state or verification (the design boundary in `CONTRIBUTING.md`).
- Nothing reaches the user's branch without the user's command (default `delivery.mode: ask_human`), and `tf undo` works on the release.

## 4. Operability

- A stopped run always ends with one recommended next step and keeps the work (the scenario matrix test).
- `tf doctor`, `tf insights` and `tf inspect` are enough to explain a failed run without reading the database.
- The release workflow (tag, verify, publish with provenance) has been exercised end to end with a pre-release tag.

## Not required for 1.0

AST / semantic scope auditing, a lexical repository indexer, issue-tracker sync, multi-repository orchestration, the P2P worker swarm, and the desktop tray companion. They are valuable only if the evidence in section 1 shows they are the bottleneck.

## Process

1. Cut a release candidate (`1.0.0-rc.1`) from `main`.
2. Fill the pilot tables and attach them to the release notes.
3. Fix only what the pilot finds; anything else waits for 1.1.
4. Tag 1.0.0 when sections 1-4 are all satisfied.
