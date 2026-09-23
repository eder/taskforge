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
