# TaskForge Usage Guide

This guide covers the current TaskForge workflow from local setup through pull-request delivery.

TaskForge is designed around a simple boundary:

> Coding agents do the engineering work. TaskForge controls how that work is planned, isolated, supervised, verified, recovered, and delivered.

## 1. Install and verify the environment

### Requirements

You need:

- Node.js 22 or newer;
- Git;
- pnpm;
- at least one supported coding-agent CLI already installed and authenticated.

Supported agent harnesses currently include:

| Agent | Command |
| --- | --- |
| Claude Code | `claude` |
| OpenAI Codex CLI | `codex` |
| Google Antigravity | `agy` |

Install TaskForge from source:

```bash
git clone https://github.com/eder/taskforge.git
cd taskforge
pnpm install
pnpm build
npm link apps/cli
```

The fastest way to get going in a project is one guided command:

```bash
cd /path/to/your-project
tf setup
```

It runs three steps and asks before each one that costs time or writes a file:

1. **Environment**: `tf doctor` (git, database, ready agents). It stops with the exact fix if the folder is not a git repository, and tells you what to install if no agent is ready.
2. **Project config**: `tf init --check`, which proposes `.taskforge/config.yaml`, runs the detected test commands once to confirm they work, shows the file, and writes it only after you confirm.
3. **Test task**: a small read-only task ("describe this project"), capped at 60k tokens, that proves an agent can work here. It changes nothing.

`tf setup --yes` accepts the defaults (including the test task); `--no-smoke` skips the test task. Without a terminal and without `--yes` it asks nothing and changes nothing.

### Prove it works here, before real work: `tf selftest`

`tf setup` checks that things are installed. `tf selftest` checks that **the whole flow works**, on a throwaway project and with your real agents, so a problem shows up there and not in the middle of a real task:

```bash
tf selftest                 # the first ready agent (Claude, then Codex, then Antigravity), capped at 150k tokens
tf selftest --agent codex   # a specific agent
tf selftest --fake          # no provider is called: only checks TaskForge's own pipeline
```

It creates a tiny project with one failing test and asks the agent to make it pass, then walks the path every real run takes, printing each stage:

```text
  ✔ agent
  ✔ sandbox project
  ✔ agent run (isolated worktree, edit, verification, integration) (17.5s)
  ✔ independent check of the delivered branch      # TaskForge runs `node --test` itself on the result
  ✔ apply to the target branch
  ✔ undo the applied run
  Tokens used: 58,573 (~$0.15) · 59% of the 100,000 budget
```

When a stage fails it stops, says which one, shows the recorded cause (not a summary) and what to try ("the agent is not signed in or its login expired: open that CLI once…"). A real agent is called, so it asks first on a terminal (`--yes` skips the question; without a terminal it does nothing until you pass `--yes` or `--fake`). `--keep` leaves the throwaway project for inspection. Exit code 0 means every stage passed.

You can also run the pieces yourself. Check the environment:

```bash
tf doctor
```

Inside the interactive shell, the equivalent operational view is:

```text
/health
```

## 2. Start TaskForge in a repository

You can start `tf` from any sub-folder of the repository (for example `zaira/server`). TaskForge works from the **project root**, the enclosing git repository, so it always uses the same `.taskforge/` (database, runs, config) and prints `TaskForge: using the project root ... (you are in server)` when that differs from where you are. Set `TASKFORGE_PROJECT_ROOT=/path` to choose the root explicitly.

TaskForge operates on the Git repository in your current working directory.

```bash
cd /path/to/your-project
tf
```

At startup, TaskForge detects the repository, Git state, configured router, installed agent harnesses, and known provider availability.

The primary interface is conversational. You do not need to translate normal engineering work into a special task DSL.

Examples:

```text
> investigate why checkout latency doubled after the cache migration
```

```text
> fix the race condition in payment retries and add a regression test
```

```text
> refactor the retry policy, but do not change the public API
```

```text
> explain how this repository works without modifying anything
```

## 3. Understand execution intent

TaskForge distinguishes read-only work from writable engineering work.

A request such as:

```text
> explain how this repository works
```

should remain read-only.

A request such as:

```text
> fix the retry implementation
```

is writable implementation work.

You can write in any language. The read-only check combines two readings of your request and always keeps the stricter one:

1. a fixed set of patterns (English and Portuguese phrases such as "do not modify anything" or "somente análise"), and
2. the planner model, which reads the request in whatever language you wrote and reports whether it is analysis-only, forbids changing the repository, or names files that must stay untouched.

The model can only tighten a run: it can turn a request into read-only or add "do not touch X" restrictions, but it can never reopen a request the patterns already marked read-only. If the model is unavailable (no API key, timeout), only the patterns apply, so in other languages state read-only intent explicitly or check the plan's `Execution intent` line. The settled intent is stored with the run, so `tf resume` cannot loosen it.

A leading "yes" / "no" (or "y" / "n") only answers a pending plan or permission question. With nothing waiting, a message such as "No modifiques nada…" is treated as a new request.

This distinction matters because writable tasks can create isolated worktrees, commits, verification activity, integration state, and delivery options. Read-only analysis should not produce delivery artifacts.

## 4. Review the plan before execution

The proposal includes an **Estimated usage** line: an approximate token range for the whole run, shown before you approve so a large plan cannot spend provider quota unnoticed. It is deliberately wide and marked `confidence low` until TaskForge has calibration history from past runs.

For writable work, TaskForge proposes a structured plan.

A plan can contain:

- tasks;
- dependencies;
- task type;
- allowed scope;
- acceptance criteria;
- proposed agents and roles;
- collaboration strategy.

You can approve the plan:

```text
> yes
```

or:

```text
/approve
```

You can revise it conversationally before execution:

```text
> don't touch package.json
```

```text
> split the database migration from the API change
```

```text
> keep the iOS work with Codex
```

You can also add a direct constraint:

```text
/constraint do not modify the public API
```

Inspect the current plan at any time:

```text
/plan
```

Reject the proposed plan with feedback:

```text
/reject keep this to one implementation task
```

## 5. Repository instructions

TaskForge discovers repository-authored instruction files that can influence planning.

Current primary instruction entry points are:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
```

TaskForge also discovers applicable nested instruction files and local Markdown references.

Use these files for durable repository guidance such as:

```markdown
# AGENTS.md

- The ios/ directory is owned by Codex.
- Do not invent backend API contracts.
- Run the project-specific verification command before declaring completion.
- Never modify generated files directly.
```

Project instructions are especially useful when the repository has constraints that should survive beyond a single prompt.

Important: repository instructions inform planning, but you should still express critical one-off constraints in the current request when they materially affect the task.

## 6. Watch the team work

Once execution starts, TaskForge becomes a live cockpit.

Useful commands:

```text
/tasks
/status
/agents
/stream
```

### Inspect task state

```text
/tasks
```

To inspect a specific task when supported by the active context:

```text
/tasks TASK-02
```

### Open the dashboard

```text
/status
```

### View active agents

```text
/agents
```

### Stream live output

```text
/stream
```

or:

```text
/stream TASK-02
```

### Focus one agent

```text
/focus 2
```

While focus mode is active, normal text is routed to that live agent session.

Return to the TaskForge overview with:

```text
/back
```

### Inspect raw provider output

```text
/raw
```

or select an agent index:

```text
/raw 2
```

## 7. Human decisions and permissions

TaskForge tries to keep reversible, isolated engineering activity automatic while surfacing decisions that need a human.

When an agent reaches a question, permission, confirmation, or authentication boundary, inspect pending interactions:

```text
/pending
```

Approve according to the interaction shown by the shell:

```text
/approve <request-id>
```

or deny it:

```text
/deny <request-id>
```

Do not treat provider exit success as proof that the engineering task finished. TaskForge separately evaluates completion evidence and verification.

## 8. What happens when a task fails

TaskForge uses bounded recovery rather than an unbounded retry loop.

With the default:

```yaml
verification:
  maxReworkCycles: 2
```

the normal recoverable path is:

```text
attempt 1 fails
  ↓
same agent receives the concrete failure evidence
and repairs the existing candidate state
  ↓
attempt 2 fails
  ↓
TaskForge reassigns to another healthy agent
with accumulated recovery context
  ↓
next failure exceeds the recovery budget
  ↓
task becomes BLOCKED
  ↓
the run cannot reach delivery
```

Recovery context can include:

- the failing phase;
- the previous agent;
- failure reason;
- verification command;
- exit code;
- stdout/stderr excerpts;
- candidate commit.

This is intended to make retry behavior diagnostic rather than repetitive.

### What TaskForge repairs by itself, and what it does not

- **Code or test failures** (attempts 1 and 2 above): the agent repairs its own work with the evidence, then another agent tries.
- **Transient machine failures during verification** (a lock held by another process, a dropped connection, a timeout): the same checks run once more after a short wait. Nothing is skipped or weakened to make a check pass; both attempts stay in the record (`VERIFY_RETRIED_TRANSIENT`).
- **Problems that need you**: a check command that does not work for the project, a broken environment, a policy. TaskForge never skips verification to get past them. It keeps the agent's work, names the cause, and recommends one action.

### When the checks cannot run here

Checks run in an isolated copy of your repository. That copy has no gitignored files (such as `.env`) and, by design, none of the environment variables whose names contain `KEY`, `TOKEN`, `SECRET` or `PASSWORD`. A test suite that needs an API key, a database or an installed dependency can therefore fail to even start, for reasons that have nothing to do with the agent's change (for example `35 errors during collection: no LLM api_key configured`).

TaskForge recognises these failures (missing key or variable, connection refused, module not found) as **environment** problems: it does not retry the agent, keeps the work, and the report says what is probably missing:

- a secret-looking variable the tests need: list it under `verification.passEnv`;
- a gitignored file such as `.env`: add it to `execution.worktreeLinks`;
- a service the tests connect to (a database): start it before resuming;
- a dependency that is not installed in the environment the checks use.

Then `tf resume` re-checks the kept work without calling an agent. `git show --stat <kept branch>` (printed in the report) shows what the agents changed in the meantime.

### A suite that already has failures

Many real projects have tests that fail before anyone touches the code (a service that is down, a missing key, an old failing test). Judging a change by the whole suite's exit code would block every change.

So the preflight measures each check command on the unchanged code and records which tests fail there. After the agents' work, a check counts as **passed when it fails only with those same failures**, and it is reported honestly:

```text
✔ TASK-02  Add retry: test: no new failures (it already had failures before the change, which this change neither caused nor fixed)
```

When the change **adds** a failure, only the new ones are shown, to the person and to the agent that has to fix it:

```text
New failures compared with before the change (2 already failing are ignored):
- FAILED tests/new.py::test_c
```

Failures are recognised in the output of pytest, vitest/jest, `go test`, `node --test` and `cargo test`. For any other format there is nothing to compare, and the check is judged by its exit code as before. A command that passed before gets no leniency. The measurement is stored with the run, so `tf resume` keeps judging against the same starting point. Turn all of this off with `verification.preflight: false`.

### TaskForge repairs the environment itself

You should not have to fix this by hand. TaskForge does three things so that a run does not end with a to-do list for you:

1. **Preflight.** Before any agent works on a writable run, TaskForge runs your project's check commands once on the unchanged code, in the same isolated copy the agents' work is checked in. If the checks **prove nothing** (the command cannot start, a `.env` is missing so every test fails to load, the run dies at collection, or its output cannot be read), the run stops **before any tokens are spent**, with the evidence. If the suite **ran** and only some tests fail, even because they need something this environment lacks (a service on a port, a data file), the run continues: those failures are recorded as the starting point and only new failures count. Tests that talk to a running service could not verify the change anyway, since they test that service and not the isolated copy; the preflight says so and names the port. Turn it off with `verification.preflight: false`.
2. **`tf fix [run]` / `/fix`.** It reads the recorded evidence and the project, and repairs what it can point at:
   - a gitignored `.env` in your checkout: it is added to `execution.worktreeLinks`, so the isolated copies see it (the agents can read it there too, as they can in your checkout);
   - a secret-looking variable the failure names and you have: added to `verification.passEnv`;
   - a file the tests open that your checkout has but git does not track (`No such file or directory: 'audio/sample.wav'`): that path is linked; if it exists nowhere in your checkout, the change referred to a file that is not there, and the agent is told instead of the run being blocked;
   - a service the tests connect to: if the failure refuses a local port and a docker compose file publishes it, `docker compose -f <file> up -d <service>` is run and TaskForge waits for the port.
   Then it continues the run (`tf fix --no-resume` only repairs). Config changes are written to `.taskforge/config.yaml` with your comments kept. The report offers it as the next step, and in the REPL a bare Enter accepts it; the line says exactly what it will do first.
3. **Anything else is a plain message.** In the REPL, if what you write is about a run that stopped ("fix the reviewer's points", "continue"), TaskForge continues that run and gives your words to the agents as an instruction. If the run is blocked by something it can repair, it shows the repair, you press Enter, and your instruction is carried through. No run id needed.

Check output is captured at 220 columns (test runners otherwise cut their summaries at 80, hiding the path a failure is about), and the evidence keeps the distinct error lines that sit before a final "8 errors" summary.

### Reviewers' findings are acted on

When a team ends with an independent reviewer, the reviewer is asked to finish with `REVIEW_VERDICT: APPROVED` or `REVIEW_VERDICT: REJECTED` plus the required changes. Each team member receives what the previous one produced (as reference data to check, so a reviewer reviews the author's work and not whatever it finds in the repository). A rejection is sent back to the author once (the implementer, or the lead when the task has none, such as a written analysis), in the same worktree (`collaboration.reviewFixPasses`, default 1; `0` only reports them), and the fixed work is what goes on to verification. A reviewer that ignores the format changes nothing.

### One recommended next step

When a run does not complete, the report ends with a single recommendation, not a menu:

```text
Next: tf init --check   — a check command does not work for this project, so no change can be verified; fix it, then "tf resume run-…" re-checks the kept work without calling agents
Also: tf resume run-…   ·   tf inspect run-…
```

| Situation | Recommended |
|---|---|
| a check command does not work for the project | `tf init --check`, then `tf resume` |
| the environment cannot run the checks | fix it, then `tf resume` |
| a policy stopped the run | `tf inspect` |
| stopped at the token budget | `tf resume <run> --budget <more>` |
| the work itself failed after retries | `tf resume` (the agent continues from its kept work) |

That table is what the command line prints. The REPL does not hand you commands: it goes into the run (see below).

### In the REPL, a stopped run is a conversation

When a run stops, the REPL **enters it**. It says in plain words what stopped the run, what it would do about it, and what you can do:

```text
  ✖ Memory extraction [BLOCKED]
      The checks need something the isolated copy does not have: …

  The checks cannot run in the isolated copy, so the work could not be verified. That is not a problem with the change.
  What I'd do: link server/.env into the isolated copies so the tests can load it; and start the "memory-postgres" service on port 5432. Then continue the run.

  ↵ Enter: fix this and continue   ·   or just tell me what you want   ·   /back to leave this run
```

- **Enter** (or a plain "yes") does what it proposed and continues the run. What it proposes depends on the cause: repair the environment and continue; raise the token cap (it says to what) and continue; let the agent continue from the work it kept; re-check after something only you can do.
- **It asks when it needs something from you.** If the checks need a service on a port and no docker compose file starts it, it asks for the command that starts it, runs what you type, waits for the port and continues. If the project's check command does not work, it asks which command verifies the project, saves it in `.taskforge/config.yaml` and re-checks.
- **Type anything else** and it goes to that run as your instruction ("use the smaller fixture set"). With a planner model, a message that is clearly a new task leaves the run and is planned normally; without one, the message goes to the run.
- **A message typed outside the run never starts it silently.** If the planner decides a message is about a run that stopped earlier, TaskForge says which run, how many of its tasks are left and what it has spent, and waits for Enter. `/back` then `/clear` plans it as a new task instead (a new plan is always shown before it runs).
- **If something inside TaskForge itself fails**, you get one plain line (not a stack of git advice), the statement that integrated and kept work is still there and nothing was applied to your branch, and Enter tries again from where it stopped.
- **`/back`** (or a plain "no") leaves the run. It stays in `/runs` and `/retry` continues it later. Starting a new task or `/clear` also leaves it.

`/fix` and `/retry` still exist for when you want to name a run yourself.

You can inspect task/run state with:

```text
/tasks
/inspect
```

Manual reassignment is also available:

```text
/reassign TASK-02
```

or, when choosing a specific healthy agent is supported by the active state:

```text
/reassign TASK-02 codex
```

## 9. Pause, cancel, and resume

Pause orchestration:

```text
/pause
```

Continue a paused execution:

```text
/unpause
```

(`/resume` still works as an alias. It is not the same as `tf resume`, which continues a run that failed, was cancelled or was interrupted; see below.)

Cancel the active run:

```text
/cancel
```

Cancel one active assignment by index:

```text
/cancel 2
```

TaskForge keeps persisted run state and audit information so you can inspect what happened afterward.

### When a task is blocked, the agents' work is not lost

If agents produced a change and the task is then blocked (verification failed, a policy stopped it, a reviewer was unavailable), TaskForge keeps that change on a branch named `taskforge/candidate/<run>/<task>` and the end-of-run report names it. Nothing has to be recovered by hand.

What `tf resume <run-id>` does with it depends on **why** the task was blocked:

| Blocked because | `tf resume` |
| --- | --- |
| The verification command itself does not work for the project (wrong test runner, missing plugin, command not found), the environment cannot run the checks, or a policy such as "no independent reviewer available" | Re-runs only the checks on the kept work. **No agent is called**, so fixing the configuration and resuming costs no tokens. |
| The work itself was wrong (a real failing check, rejected review, out-of-scope change) | The agent continues **from the kept commit** with what went wrong, instead of starting over. |

Use `tf resume --fresh <run-id>` to discard the kept work and start the task over.

If you applied the change yourself (for example by cherry-picking the kept commit), do **not** resume the run: the agents would find nothing to change and the task would be blocked again. Close it with `tf abandon <run-id>`; it is then ignored by `tf resume` and shown as ABANDONED in `tf runs`. Nothing is deleted, and kept work stays on its `taskforge/candidate/*` branch.

A typical case: `tf init` proposed a test command that does not suit the project, the first code task was blocked, you fix `.taskforge/config.yaml` (for example with `tf init --check --force`), then `tf resume` finishes the task without another agent call.

### Resume an interrupted or failed run

`/pause` and `/resume` only control a live session. If a run was cancelled, crashed, or ended `failed` or `BLOCKED`, continue it from the CLI:

```bash
tf resume              # most recent failed, cancelled or interrupted run
tf resume run-<id>
```

Without an id, `tf resume` continues the newest run that can be continued; runs that cannot (for example ones created before resume checkpoints existed) are skipped and explained. Tasks already integrated into the run branch are kept and not re-executed. Every other task is reset and re-run with a fresh recovery budget, starting from the cumulative run branch. Planning and negotiation are not repeated. Completed runs cannot be resumed — deliver them with `/diff`, `/apply` or `/pr`.

### Context between runs

If your request depends on what a recent run produced ("do item 1", "fix what you suggested", or the same in any other language, or a `run-…` id), TaskForge attaches that run's report (within `context.maxAgeHours`, default 24) to the planner and the agents. The planner model makes the call, so it works in the language you write in; when there is a recent run it costs one small extra model call. The plan proposal shows `Context: using the output of <run> …`, so you always see what was used. To avoid it, reject the plan and rephrase, or set `context.carryOver: false`.

Without a model (no API key), only very short messages are treated as follow-ups.

The attached text is **reference data, not instructions**: agents are told to verify it against the repository and follow only your current request. It is stored with the run, so `tf resume` uses the same context.

Headless: `tf run "…" --context <run-id|last>`.

```yaml
context:
  carryOver: true     # false disables automatic attachment
  maxAgeHours: 24     # only runs newer than this are considered
  maxChars: 12000     # budget; the final (consolidating) output is kept first
```

If a dependency is not caught, name the run (`run-…`) or use `--context`.

## 10. Verification and completion

TaskForge separates three ideas that are often incorrectly treated as equivalent:

```text
agent process finished
        ↓
task completion evidence accepted
        ↓
repository verification passed
```

Configured verification can include:

- tests;
- lint;
- typecheck;
- review;
- explicit task verification commands.

A code-changing task with verification requested but no executable verification evidence fails closed rather than being silently marked verified.

### Dual review for sensitive tasks (opt-in)

For changes where one agent's judgement is not enough (authentication, payments, schema migrations), TaskForge can require an **independent agent** to approve the change before it is integrated:

```yaml
verification:
  dualReview:
    enabled: true
    scopes: ['db/migrations/**', 'src/auth/**']   # always sensitive
    # keywords: [...]                              # defaults include authentication, payment, schema migration, ...
    onNoIndependentReviewer: block                 # or "skip"
```

How it works:

- A task is sensitive if its writable scope matches `scopes`, its title/objective mentions a keyword, or it is explicitly flagged (`contract.metadata.sensitive`). This is decided by configuration, never by model output.
- After automated verification passes, a **different** healthy agent (never one that worked on the task) reviews the candidate commit read-only in an isolated worktree.
- The reviewer must end with `REVIEW_VERDICT: APPROVED` or `REVIEW_VERDICT: REJECTED`. A missing or conflicting verdict counts as a rejection.
- A rejection feeds the reviewer's findings into the normal bounded recovery loop (same agent repairs, then reassignment, then BLOCKED). Nothing is integrated without approval.
- If no independent reviewer is available, the task is BLOCKED (`block`, default) or the review is skipped with a visible warning (`skip`).
- Events `DUAL_REVIEW_REQUIRED`, `DUAL_REVIEW_APPROVED`, `DUAL_REVIEW_REJECTED` and `DUAL_REVIEW_UNAVAILABLE` are recorded for audit (`/inspect`).

Note: the reviewer runs outside the parallelism pool (it cannot wait for a slot held by the task it reviews), so a sensitive task can briefly use one extra agent process.

Projects can explicitly disable selected repository verification categories in configuration when that is intentional.

## 11. Delivery

Successful writable task results are integrated into a run-specific branch.

Inspect the result before delivery:

```text
/diff
```

or for a previous run:

```text
/diff run-<id>
```

`/diff` starts with the files changed and ends with a plain-language account of the change:

```text
What it does: Add retry with backoff to the sync client
How it was checked:
  ✔ TASK-01  Add retry: test, lint passed
  ⚠ TASK-02  Update docs: no automated checks ran (a documentation-only change, or no check commands are configured)
Partly verified: read the diff of the tasks marked ⚠ before applying.
```

"Passed" is only reported as verified when checks actually ran. A run whose tasks passed with nothing executed is shown as **not verified**, so a green result is never mistaken for evidence.

Apply the completed run to its target branch:

```text
/apply
```

If the changes were not fully verified, `/apply` shows the account above and stops; `/apply --yes` applies anyway. `tf apply` does the same: it prints the account, and on a terminal asks `Apply anyway?` (anything but `y` stops; `--yes` skips the question; without a terminal it warns and proceeds so automation keeps working). Fully verified runs apply without asking.

Changed your mind? Undo the last applied run:

```text
/undo          # or: tf undo [run]
```

Undo adds a revert commit (`git revert -m 1` of the merge TaskForge made). Nothing is rewritten, so it is safe even after you pushed, and the change can be brought back by reverting that revert (the command prints it). It refuses when the working tree is dirty, and if later work conflicts with the revert it changes nothing and tells you the `git revert` to run by hand. `tf runs` shows undone runs as `↩ undone`.

Create a GitHub pull request:

```text
/pr
```

The PR is opened from a human-readable delivery branch derived from the goal (for example "Add commitment intelligence" becomes `taskforge/commitment-intelligence`), created at the run's final commit. If that name is already taken by different work, a numeric suffix is added. The ephemeral `taskforge/run-<id>` branch is kept as the internal integration branch.

For a previous run:

```text
/pr run-<id>
```

If you do not want to apply or open a PR, keep the integration branch without delivery:

```text
/discard
```

The important boundary is that verified autonomous execution and external delivery are separate actions.

## 12. Inspect previous work

### Naming a run without copying its id

Anywhere a run is expected (`tf resume`, `tf apply`, `tf inspect`, `tf abandon`, `tf cost`, `tf pr create`, and `/diff`, `/apply`, `/pr`, `/inspect` in the REPL) you can write:

| You write | Meaning |
|---|---|
| `last` | the newest run |
| `2` or `#2` | the number shown by `tf runs` (`#1` is the newest) |
| `4521` | the end (or start) of the id, when it is unique |
| `run-1790…` | the full id |

An ambiguous fragment is refused with the matching ids rather than guessed.

### Continuing and starting fresh

TaskForge does not keep a chat transcript; what carries over is the run history. When you open `tf`, it prints `Continuing from run-… (3h ago: <goal>)` for the newest run still within `context.maxAgeHours`, and requests that depend on it get its report automatically (see "Context between runs").

- `/clear` starts fresh: earlier runs stop being used as context for new requests, and a plan waiting for approval is discarded. Nothing is deleted: `/runs`, `tf resume`, `tf apply` and `tf inspect` still see every run. A run that is executing is left alone.
- `tf --new` opens the REPL already cleared.

List runs:

```text
/runs
```

Inspect a run:

```text
/inspect run-<id>
```

From the non-interactive CLI:

```bash
tf runs
tf inspect run-<id>
tf inspect run-<id> --json
```

## 13. Usage and orchestration telemetry

Token/cost telemetry:

```text
/cost
```

Execution/orchestration statistics:

```text
/stats
```

### How TaskForge is doing in this project

```bash
tf insights               # last 30 days
tf insights --since 7     # last 7 days
tf insights --json
```

```text
Last 30 days: 14 runs
  Outcomes: 8 completed, 4 failed, 2 abandoned
  Finished successfully: 57% of the runs that ended
  Needed tf resume: 5
  What stopped work most:
    3×  a check command that does not work for the project
    2×  the token budget was reached
  Tokens: 2,140,000 in total, about 214,000 per run (~$3.10)
```

It shows where to invest (a recurring stop cause is a config or environment fix, not a model problem) without anyone pasting logs. It is computed from this project's local database only; nothing is collected or sent.

### What the plan's estimate does and does not tell you

The plan proposal shows an estimated range. Once the project has a few runs it also prints what its last agent assignments really used ("about 740k tokens each, up to 1,000k"), which is the better guide for a plan with several tasks. The estimate is not a ceiling: the team shown is for the first task, and each task is staffed when it starts (up to `collaboration.maxAgentsPerTask`, default 3, agents each). A heavy task can use several agents in sequence, so real usage can exceed the estimate; the proposal says so and shows the token cap that will stop the run.

If the planning model does not answer within `router.timeoutSeconds` (default 60), TaskForge falls back to a simpler plan and says why in the proposal. For a pasted numbered list ("1. … 2. …") that fallback makes one task per numbered item, with the bullets under it as details.

### Capping what a run can spend

At the end of every run TaskForge prints what it actually used, for example:

```text
Tokens used: 312,400 (~$1.20) · 62% of the 500,000 budget · the plan estimated ~120,000 · most went to TASK-02 (180,000, 58%)
```

Only usage reported by the agents is counted; when an agent reports none, the line says the cost is unknown.

Set a ceiling per run in `.taskforge/config.yaml`, or per command:

```yaml
execution:
  tokenBudget: 500000   # tokens per run, all attempts included (default: set by the profile; 0 = no cap)
```

The default comes from the profile (next section). Set `0` to remove the cap.

### Profiles: how much a run may use

Real runs showed what staffing costs: on a real project each agent assignment used roughly 0.5 to 1 million tokens (mostly context it reads), so a team of three on one task spent 2.7M. The default is therefore the cheapest setup that works, and more is opt-in:

| `execution.profile` | agents per task | token cap |
|---|---|---|
| `economy` (default) | 1 | 1,000,000 |
| `standard` | 2 (the author and a reviewer) | 2,000,000 |
| `thorough` | up to 3 | 4,000,000 |

Anything you set explicitly (`collaboration.maxAgentsPerTask`, `execution.tokenBudget`) wins over the profile. When a team is cut down, the implementer is always kept, then a reviewer, then explorers. The plan proposal shows the team the run will really use.

Two more things keep a plan from costing more than the change deserves. The planner is asked for at most `planner.maxTasks` tasks (default 6) and told that tests and documentation for a change belong inside the task that makes it; a longer plan is sent back to be combined. And a reviewer is handed the **diff** of the change (not "go and find it"), and told not to run the full suite, since TaskForge runs the checks itself.

```bash
tf run "…" --budget 500k
tf resume last --budget 1.5m     # new total cap; what was already spent counts
```

At 80% TaskForge warns. At 100% it **stops starting new tasks**, and a team stops before starting its next member or a reviewer's fix pass, keeping the work done so far. Only the one agent already running finishes (killing it would leave half-done changes), so a run can pass the cap by at most that one agent's usage, and ends as a resumable run with "Stopped at the token budget" and the exact `tf resume … --budget` command. Nothing is lost.

TaskForge treats provider token usage as telemetry. It should not label a run efficient or inefficient based only on absolute token volume; orchestration efficiency requires evidence such as failed assignments, unnecessary fan-out, rework, or cancelled work.

## 14. Headless and automation

### Full run pipeline

```bash
tf run "Fix the websocket reconnection leak"
```

Set the maximum concurrency:

```bash
tf run "Fix the websocket reconnection leak" --concurrency 2
```

### Resume a run

```bash
tf resume run-<id>
```

See [Pause, cancel, and resume](#9-pause-cancel-and-resume).

### Headless execution

```bash
tf exec "Add regression coverage for checkout retries" --yes --concurrency 2
```

Headless mode uses the configured headless policy when human interaction would otherwise be required.

Example project configuration:

```yaml
headless:
  onHumanQuestion: block
  onUnknownPermission: deny
  onAuthenticationRequired: fail
  onConfirmationRequired: block
```

### GitHub issue workflow

TaskForge can import a GitHub issue as an engineering objective:

```bash
tf issue 123
```

### Delivery from CLI

```bash
tf apply run-<id>
tf pr create run-<id> --base main
```

Create a draft PR:

```bash
tf pr create run-<id> --base main --draft
```

## 15. Configuration

### Do I need `.taskforge/config.yaml`?

**No. The file is optional.** Without it TaskForge runs with its defaults, and it never creates the file on its own. It exists for settings the defaults cannot know, above all **how to verify a code change** in your project.

| Your project | Without the file |
| --- | --- |
| Node (`package.json` with `test`/`lint`/`typecheck` scripts) | Works: TaskForge discovers those scripts itself. |
| Python, Go, Rust, Swift, ... | Read-only and documentation-only tasks work. A task that **changes code** is BLOCKED, because there is nothing to verify it with. |

To create one, run `tf init` in the project. It detects what it can (Node, Python with its virtualenv, Go, Rust, Swift packages, a Makefile `test` target), **prints the proposed file and asks before writing it**, and never overwrites an existing config (`--force` replaces it).

```bash
tf init            # show the proposal, ask, then write
tf init --print    # only show it
tf init --check    # also run each detected command once and report whether it works
tf init --check --check-timeout 300   # allow slower commands (default 120s)
tf init --yes      # write without asking (scripts/CI)
```

`--check` shows the command's first output lines live, prints a heartbeat every 10s, stops the command after the time limit (default 120s), can be stopped with Ctrl-C, and closes stdin so a command waiting for input cannot hang. When a command fails it shows the last lines and, for common causes (asyncio script-style tests run under `pytest`, a missing virtualenv or dependency, tests that need a running service), a specific tip. Use it for projects whose tests do not run the way the detector guesses (for example test files that are run one by one as scripts instead of with `pytest`). Edit the file freely afterwards.

**Test suites run as scripts.** Some projects run each test file directly (`python test_x.py`) instead of with `pytest`. `tf init` recognizes this (most `test_*.py` files have a `__main__` guard or call `asyncio.run`) and proposes a loop over the scripts. With `--check` it runs each script on its own (up to 60s each) and keeps **only the ones that pass in this environment**; the rest are listed as comments with the reason, usually because they need a database, a server or audio. The list is explicit, so add new test files to it as you create them.

When you start `tf` in a project without the file, it prints a short notice (once per project) explaining all of this. You can ignore it: nothing else changes. Set `TASKFORGE_NO_HINTS=1` to never see it. `tf doctor` also shows whether the project has a config.

The file is local to the project you run `tf` in, and `~/.taskforge/config.yaml` can hold settings shared by all projects. Later files override earlier ones: defaults, then global, then project.

Project-local configuration:

```text
.taskforge/config.yaml
```

Global configuration:

```text
~/.taskforge/config.yaml
```

Example:

```yaml
router:
  provider: openai
  model: gpt-5.6-luna
  fallback: static
  # timeoutSeconds: 60   # how long the planner waits for the model before using a simpler plan

execution:
  maxParallelTasks: 3
  defaultTimeoutMinutes: 30
  worktreesDir: .taskforge/worktrees
  databasePath: .taskforge/taskforge.db
  runsDir: .taskforge/runs
  # autoPruneOlderThan: 7d   # opt-in cleanup of stale worktrees/branches at run start
  # tokenBudget: 500000       # stop starting new tasks after this many tokens per run

collaboration:
  maxAgentsPerTask: 3

permissions:
  filesystem:
    workspace_write: allow
    outside_workspace: ask_human
  commands:
    tests: allow
    lint: allow
    package_install: ask_human
  git:
    commit: allow
    push: ask_human
    force_push: deny
    merge_main: deny

verification:
  tests: true
  lint: true
  typecheck: true
  review: true
  maxReworkCycles: 2
```

### Verification commands in a real project

- Commands run through the shell (`sh -c`), so quotes, `&&`, pipes and `VAR=1 cmd` work. Each has a timeout of `verification.commandTimeoutSeconds` (default 600).
- They inherit your environment (`DATABASE_URL`, `JAVA_HOME`, ...), except secret-looking names (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`) and TaskForge's router key. List any such variable your tests need in `verification.passEnv`.
- Every task runs in a fresh git worktree, which has no installed dependencies. TaskForge symlinks `node_modules` (also `packages/*/node_modules` and `apps/*/node_modules`) from your checkout into each worktree (`execution.worktreeLinks`; set `[]` to disable). The links are excluded from git and are never committed. Other ecosystems (Python virtualenvs, Go/Rust caches, Pods) are not linked: point `verification.commands` at something that works from a clean checkout, or add the relevant directories to `execution.worktreeLinks`.
- Changes that only touch documentation files (`.md`, `.txt`, `.rst`, ...) do not need verification evidence; anything else still does.
- Auto-discovered verification only exists for projects with a `package.json`. For any other project set `verification.commands` (or `scopedCommands`); a code-changing task with no verification evidence is BLOCKED instead of being delivered unverified.
- When a run stops for lack of a check command, TaskForge reads the files the agent wrote and proposes one (pytest in a throwaway virtual environment for Python, `go test ./...`, `cargo test`, `mvn -q test`, `./gradlew test`, or a Makefile `test` target). Press Enter to save it in `.taskforge/config.yaml` and re-check; type a different command to use that instead. Nothing is saved without your Enter.
- Caveat: because `node_modules` is shared, an agent that runs a package install inside its worktree changes your real `node_modules`. Keep `permissions.commands.package_install: ask_human`.

### Agent environment and write boundaries

Agents are started with a minimal environment. Each one receives only its own provider's credentials, never TaskForge's router key (`TASKFORGE_OPENAI_API_KEY`), and not `SSH_AUTH_SOCK`. To forward an extra variable to one agent, list it by name:

```yaml
agents:
  codex:
    passEnv: [HTTPS_PROXY]
```

Tasks that declare a narrow `allowedScope` are checked after the agent finishes: files changed outside that scope fail the task (the agent retries with the offending files as evidence, then the task blocks). This is on by default; disable it only if your planner scopes are too coarse:

```yaml
verification:
  enforceScope: false
```

See [SECURITY.md](../SECURITY.md#security-model-and-known-limitations) for what TaskForge does and does not enforce, and [docs/pilot.md](pilot.md) for a checklist to validate it with real agents.

### Additional agent CLIs (opt-in)

Claude Code, Codex CLI and Google Antigravity are registered automatically. These harnesses are available but only registered when you list them under `agents` (they are skipped otherwise, even if installed):

| id | CLI | Default invocation |
| --- | --- | --- |
| `cursor` | Cursor CLI (`cursor-agent`) | `--output-format stream-json --force -p <prompt>` |
| `aider` | Aider | `--yes-always --no-pretty --no-stream --no-auto-commits --no-check-update --message <prompt>` |
| `opencode` | OpenCode | `run <prompt>` |
| `goose` | Goose | `run --no-session -t <prompt>` |

```yaml
agents:
  cursor:
    enabled: true
    maxParallel: 1
  aider:
    enabled: true
    command: /opt/homebrew/bin/aider   # optional
    args: ['--yes-always', '--message'] # optional: replaces the default arguments
```

These adapters are **experimental**: the default arguments follow each tool's documented non-interactive mode but have not been verified against every release. They run non-interactively, so permission and question prompts are handled by the provider itself. Override `command`/`args` if your installed version differs, and run `tf doctor` to confirm detection. Setting `enabled: false` for any harness (including the built-in three) removes it from the registry.

### Optional OpenAI planner/router

Set:

```bash
export TASKFORGE_OPENAI_API_KEY="..."
```

TaskForge can fall back to deterministic/static routing if the configured AI router is unavailable.

## 16. Common workflows

### Read-only repository analysis

```text
> explain the architecture of this repository without modifying anything
```

Expected result: analysis only, no delivery branch or PR offer.

### Implementation with a hard constraint

```text
> fix the authentication timeout, but do not change the public API
```

Review the plan, add constraints if necessary, then execute.

### Implementation plus independent review

```text
> change the payment retry behavior and use an independent reviewer for the ledger boundary
```

TaskForge may assign different roles when fan-out has a concrete benefit.

### Recover a failed task

Normally TaskForge handles bounded recovery automatically. Inspect the evidence:

```text
/tasks
/inspect
/raw
```

If you need to intervene:

```text
/reassign TASK-02
```

### Create a PR

```text
/diff
/pr
```

or:

```bash
tf pr create run-<id> --base main
```

## 17. Troubleshooting

### No agent is ready

Run:

```bash
tf doctor
```

Then verify at least one supported agent command works directly:

```bash
claude --version
codex --version
agy --version
```

You only need one supported agent to begin.

### Router is unavailable

Check:

```bash
tf doctor
```

If you intend to use the OpenAI router, verify:

```bash
echo "$TASKFORGE_OPENAI_API_KEY"
```

TaskForge can use the static fallback when configured.

### A task is blocked

Inspect:

```text
/tasks
/inspect
```

A blocked task means TaskForge stopped rather than continuing past the configured recovery/safety boundary. Delivery should remain unavailable until the unresolved work is addressed.

### Worktrees need cleanup

Inside the shell:

```text
/clean
```

or:

```bash
tf clean
```

To remove only stale artifacts left by crashed or interrupted sessions (worktrees, leftover directories and temporary `taskforge/TASK-*` / `taskforge/integration-*` branches), prune by age. Run integration branches and delivery branches are never removed:

```bash
tf cleanup --prune --older-than 7d --dry-run   # preview
tf cleanup --prune --older-than 7d
```

To do this automatically at the start of every run, set `execution.autoPruneOlderThan: 7d` in `.taskforge/config.yaml`.

### You want the full command list

Inside TaskForge:

```text
/help
```

or type:

```text
/
```

to open the interactive command menu.

## Next reading

- [README](../README.md)
- [Git branch lifecycle and hardening](git-branch-lifecycle-and-hardening.md)
- [Interaction Gateway specification](spec-v2-interaction-gateway.md)
- [Architecture phases 0–5](architecture-phases-0-5.md)
- [Architecture phases 6–13](architecture-phases-6-13.md)
- [Architecture phases 14–22](architecture-phases-14-22.md)
