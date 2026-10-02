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

Check the environment:

```bash
tf doctor
```

Inside the interactive shell, the equivalent operational view is:

```text
/health
```

## 2. Start TaskForge in a repository

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

Resume:

```text
/resume
```

Cancel the active run:

```text
/cancel
```

Cancel one active assignment by index:

```text
/cancel 2
```

TaskForge keeps persisted run state and audit information so you can inspect what happened afterward.

### Resume an interrupted or failed run

`/pause` and `/resume` only control a live session. If a run was cancelled, crashed, or ended `failed` or `BLOCKED`, continue it from the CLI:

```bash
tf resume              # most recent failed, cancelled or interrupted run
tf resume run-<id>
```

Tasks already integrated into the run branch are kept and not re-executed. Every other task is reset and re-run with a fresh recovery budget, starting from the cumulative run branch. Planning and negotiation are not repeated. Completed runs cannot be resumed — deliver them with `/diff`, `/apply` or `/pr`.

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

Apply the completed run to its target branch:

```text
/apply
```

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
tf init --yes      # write without asking (scripts/CI)
```

Use `--check` for projects whose tests do not run the way the detector guesses (for example test files that are run one by one as scripts instead of with `pytest`). Edit the file freely afterwards.

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

execution:
  maxParallelTasks: 3
  defaultTimeoutMinutes: 30
  worktreesDir: .taskforge/worktrees
  databasePath: .taskforge/taskforge.db
  runsDir: .taskforge/runs
  # autoPruneOlderThan: 7d   # opt-in cleanup of stale worktrees/branches at run start

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
