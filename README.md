# TaskForge

<p align="center">
  <strong>One terminal. Multiple coding agents. One controlled engineering workflow.</strong>
</p>

<p align="center">
  Open-source local-first control plane for coordinating Claude Code, Codex CLI, Google Antigravity, and local Ollama models — from fast direct multi-agent pipelines & Debate Councils to Living Plans, isolated parallel worktrees, verification, and Git delivery.
</p>

<p align="center">
  <a href="https://github.com/eder/taskforge/actions/workflows/ci.yml"><img src="https://github.com/eder/taskforge/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-blue.svg" alt="TypeScript"></a>
</p>

TaskForge does not try to be another coding model. It sits above the coding-agent CLIs you already use and turns them into a supervised engineering workflow.

You describe the outcome. TaskForge plans the work, selects agents, creates isolated Git workspaces, streams execution, handles recoverable failures, verifies results, integrates successful work, and keeps delivery explicit.

> **Autonomous, not uncontrolled.**

> [!WARNING]
> **TaskForge is experimental (beta).** Use it on a test repository, or inside a container or VM, until you trust it.
> The agents run as your user with **no sandbox**: they can read anything you can read (for example `~/.ssh`, `~/.aws`, your shell history). TaskForge never applies changes to your branch on its own; that is always your command (`/apply`, `tf apply`, `/pr`). See [Safety](#safety-read-this-first) and [SECURITY.md](SECURITY.md).

## Quick start

### Requirements

- **Node.js 22+** (`node -v`)
- **Git** (`git --version`)
- **pnpm 12+** (run `corepack enable` to activate the pinned version automatically)
- **At least one supported coding-agent CLI** installed and authenticated (no `OPENAI_API_KEY` is required to get started):
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) — `claude`
  - [OpenAI Codex CLI](https://github.com/openai/codex) — `codex`
  - [Google Antigravity](https://antigravity.google/) — `agy`
  - *(Optional, local/air-gapped)* [Ollama](https://ollama.com/) — `@ollama` (full local coding agent, zero-cost solution arbiter & local `router.provider: ollama` planner/coordinator)

> [!TIP]
> **No OpenAI API key required.** TaskForge works out of the box with whichever agent CLI(s) you already have signed in. Setting `TASKFORGE_OPENAI_API_KEY` (or a local OpenAI-compatible gateway) is optional and speeds up complex multi-task planning.

### Install from source

> TaskForge `1.0.0-rc.1` is currently installed from source (or via Docker container mode). Do **not** use `npm link apps/cli`—npm cannot resolve pnpm `workspace:*` dependencies.

```bash
git clone https://github.com/eder/taskforge.git
cd taskforge
corepack enable
pnpm install
pnpm build

# Link `tf` globally with pnpm:
pnpm --dir apps/cli link --global

# Verify the binary is on your PATH:
tf --version
```

If `tf` is still not found after `pnpm link --global` (for example if pnpm's global bin directory is not on your `PATH`), create a direct symlink instead:

```bash
chmod +x apps/cli/dist/bin.js
sudo ln -sf "$(pwd)/apps/cli/dist/bin.js" /usr/local/bin/tf
```

*(Prefer running isolated? Build and launch with Docker instead: `docker build -t taskforge .` then run `scripts/tf-container.sh` from your target repository.)*

### First 5 minutes

Enter any Git repository and verify your environment:

```bash
cd /path/to/your-project
tf setup       # guided first-time checks: environment, optional .taskforge/config.yaml, smoke test
tf selftest    # optional: proves edit → verify → integrate → apply → undo on a throwaway repo
tf
```

Inside `tf`, you start in **`auto ▸`** (Smart Auto-Dispatch):

```text
# 1. Quick direct question or edit (fast, streamed, auto-checkpointed)
auto ▸ explain how authentication works in #src/auth.ts

# 2. Chain two agents directly (implement → independent review)
auto ▸ @codex -> @claude add input validation to #src/routes/orders.ts

# 3. Convene a 3-round architectural Debate Council across your ready agents
auto ▸ /council should we store session state in Redis or Postgres?

# 4. Full orchestrated plan (isolated worktrees, verification, explicit /diff /apply /pr)
auto ▸ fix the duplicate payment race condition and add regression coverage

# 5. Open the strictly-local Web Cockpit (127.0.0.1) in your browser
auto ▸ /ui
```

TaskForge routes quick questions and `@agent` directives straight to Direct Mode (with automatic `/undo` checkpoints), and proposes a structured plan before writable multi-task orchestration.

<details>
<summary><strong>Install troubleshooting</strong></summary>

- **`tf: command not found`**: Run `pnpm bin -g` and ensure that folder is in your shell `PATH`, or use the `ln -sf "$(pwd)/apps/cli/dist/bin.js" /usr/local/bin/tf` symlink shown above.
- **Wrong `pnpm` version**: Run `corepack enable` (ships with Node.js 22+) so pnpm matches `packageManager` in `package.json`.
- **Agent reported as signed out**: Run `tf doctor` to see the exact login command (for example `claude auth login` or `codex login`).
- **Running without linking globally**: From the TaskForge clone directory, you can always execute `pnpm tf -- --version`.

</details>

## Safety: read this first

- **No sandbox.** Agents are the CLIs you already have (`claude`, `codex`, `agy`) running as your user. TaskForge limits what it forwards to them and what it integrates; it does not stop an agent process from reading files your user can read, and writes outside its worktree are not prevented or detected. Use a test repository, or run TaskForge inside a container or VM, especially with code you did not write.
- **Container mode.** `docker build -t taskforge .` then, from the project to work on, `scripts/tf-container.sh` runs TaskForge and all its parallel agents in one container that cannot see your host `HOME`. Pass provider keys as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`; sign-ins done with the host CLIs are not available inside. It does not limit network access or protect the mounted repository (see [SECURITY.md](SECURITY.md)). The image includes Claude Code and Codex; add Antigravity in a derived image.
- **Nothing reaches your branch by itself.** Work happens in isolated Git worktrees and an integration branch. `/apply`, `tf apply` and `/pr` are separate commands, `/apply` stops when the changes were not fully verified, and `tf undo` reverses an applied run with a revert commit.
- **Spend is capped by default, and teams are off.** The default `economy` profile uses one agent per task and stops starting new tasks after 1,000,000 tokens (`execution.profile: standard` allows an author plus a reviewer and 2,000,000; `thorough` up to three agents and 4,000,000; `execution.tokenBudget: 0` turns the cap off). It only counts usage the agent reports, so also watch your provider's own limits. Every run ends by printing what it used.
- **Your own approval stays in the loop.** Writable plans are shown before they run, and agents ask before actions that need a permission.

### Known limits

- Release candidate (`1.0.0-rc.1`): interfaces and configuration may still evolve before `1.0.0` GA.
- Tested on macOS and in CI on Linux (Node 22 and 24). Windows is not supported or tested.
- Deciding whether a request is read-only, and whether it refers to an earlier run, uses your planner model and works in any language. Without a model (no `OPENAI_API_KEY`) only English and Portuguese phrases are recognised for read-only requests, and only very short messages count as follow-ups.
- Conversational commands ("yes", "no", "pause", "who is available?") are keyword-based and understood in English and Portuguese only. Anything else is treated as a new request for the planner, so in other languages use the slash commands (`/approve`, `/reject`, `/pause`, `/apply`, …). A bare constraint such as "do not change .env files" typed while nothing is running is still recorded as a constraint rather than as a request.
- `tf doctor` (and the agent list at startup) asks Claude Code (`claude auth status`) and Codex (`codex login status`) whether they are signed in, with no model call, and shows a signed-out agent as not ready with the command to sign in. Antigravity has no status command, so it is reported as installed only, and a quota that has not failed yet cannot be known without a real call: quota is shown from failures TaskForge has already seen.
- Verification only helps if the project has check commands. `tf setup` / `tf init --check` configure and test them; a change that passed with no checks run is reported as **not verified**.

## What happens after a prompt

```text
You
 │
 │  "Fix the retry bug and add regression tests"
 ▼
TaskForge
 │
 ├─ reads repository context and project instructions
 ├─ classifies the execution intent (patterns + planner model, any language; stricter wins)
 ├─ builds a task graph
 ├─ selects the minimum useful agent team
 ├─ creates isolated Git worktrees
 │
 ├─ Claude Code
 ├─ Codex CLI
 └─ Google Antigravity
 │
 ├─ streams execution into one terminal
 ├─ handles human questions and permissions
 ├─ verifies completion and repository checks
 ├─ retries recoverable failures with evidence
 ├─ reassigns when bounded recovery requires it
 └─ integrates verified work into a run branch
                    │
                    ▼
             /diff  /apply  /pr
```

The coding agents remain responsible for understanding and changing code. TaskForge owns the workflow around them: process state, isolation, orchestration, recovery, verification, and delivery.

## Why TaskForge

One coding agent is easy to operate. Several coding agents working against the same real repository create a different problem:

- Which agent should own each task?
- Should the work be split, reviewed, or kept with one agent?
- How do agents work concurrently without corrupting the same checkout?
- What happens when an attempt fails verification?
- What happens when a provider becomes unavailable?
- How do you preserve failure evidence instead of restarting blindly?
- How do you know a successful process actually completed the engineering task?
- How do you inspect changes before they reach your branch?

Without a control plane, the human becomes the control plane.

TaskForge is designed to remove that coordination overhead while preserving explicit control where it matters.

## Product capabilities

| Capability | What TaskForge does |
| --- | --- |
| Smart Auto-Dispatch & Direct Mode | Fast conversational prompts (`auto`, `@claude`, `@codex`, `@agy`, `@ollama`, `@all`, `@smart`) with live streaming, `#file` & `#image` attachments, SQLite sessions, and instant `/undo` checkpoints |
| Multi-Agent Pipelines & TDD | Chain agents inline (`@a -> @b` implement→review, `@a <-> @b` debate, `@a @b --edit` competitive worktrees with hybrid per-file `mix`, `/tdd` adversarial Red→Green) |
| 3-Round Debate Council | `/council` runs independent proposals, dedicated per-solution cross-critiques, refinements, Round 4+ follow-ups, `.taskforge/councils/*.md` transcripts, and 1-Enter handoff |
| Living Plan & Wave Execution | Domain-agnostic `.taskforge/plan.md` (`/blueprint`) with greenfield detection, deterministic Wave 2 parallel fan-out, and seamless wave transitions |
| Natural-language orchestration | Turns an engineering goal into structured tasks, dependencies, contracts, and acceptance criteria |
| Repository instructions & Memory | Discovers `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, unified `/skills`, and durable cross-agent `.taskforge/memory.md` |
| Isolated parallel worktrees | Runs writable tasks in separate Git worktrees with collision-free per-worktree port blocks (`.taskforge.env`) and a Peer Mailbox + advisory file locks |
| Live supervision & Local Web Cockpit | Streams activity in one terminal (`tf`, `tf dash --stream`) or in the strictly-local `127.0.0.1` Web Cockpit (`tf ui` / `/ui`) |
| Completion Gate & Verification | Separates “process exited” from “task complete”; runs tests, lint, typecheck, baseline diffing, review, and optional dual review |
| Progressive recovery | Reuses failure evidence and candidate branches before reassigning to another healthy agent |
| GitHub Autopilot & Explicit delivery | `/fix-ci`, `/review-pr`, `/issue`, plus controlled `/diff`, `/apply`, `/pr`, `/undo`, and `/discard` |
| IDE, Automation & SDK | Stdio MCP server (`tf mcp serve`), local daemon & scheduler (`tf daemon`, `tf schedule`), lifecycle hooks & desktop notifications, `/voice`, `/multirepo`, and TypeScript `TaskForgeClient` SDK |

## Direct Mode, Pipelines & Debate Council

Inside `tf`, you don't need full orchestration ceremony for every request. In default **`auto`** mode, TaskForge routes quick questions and single-agent work directly while keeping full multi-agent power one prefix away:

```text
# Direct addressing with #file autocomplete and #image attachments
@codex fix the retry bug in #src/client.ts
@claude inspect the layout issue shown in #screenshots/header.png
@all compare Redis vs Postgres advisory locks for job deduplication

# Multi-agent pipelines & competitive edits
@codex -> @claude implement webhook signature verification and review edge cases
@claude <-> @codex debate whether to split billing into a separate worker
@claude @codex --edit refactor #src/parser.ts   # compare diffs, or mix fileA:#1 fileB:#2
/tdd @claude -> @codex enforce 100 req/min rate limiting on /api/*

# 3-round Multi-Agent Solution Debate Council
/council migrate our single-tenant Postgres schema to multi-tenant isolation

# Instant safety net, model tuning & cross-agent memory
/model codex o3 high
/memory add Always use pnpm and strict TypeScript
/undo                         # instant Direct Mode checkpoint rollback
```

See [docs/direct-mode-and-workflows.md](docs/direct-mode-and-workflows.md) for the complete guide (including `/skills`, `/compact`, `&` background jobs, `/voice`, and GitHub Autopilot `/fix-ci`, `/review-pr`, `/issue`).

## Living Plan & Phased Wave Execution

For greenfield builds or multi-module milestones, use `/blueprint` (alias `/waves`) to create and evolve a Git-trackable `.taskforge/plan.md`:

```text
/blueprint Build a multi-tenant invoicing API with Stripe webhooks and PDF export
/blueprint refine Add a dedicated audit-log slice to Wave 2
/blueprint next    # Wave 1 foundation → auto-apply + re-scan → Wave 2 parallel fan-out → Wave 3 integration
```

Parallel worktrees automatically receive collision-free port blocks in `.taskforge.env` (`PORT`, `TASKFORGE_API_PORT`, `TASKFORGE_DB_PORT`) and coordinate via a file-backed Peer Mailbox (`.taskforge/mailbox/`). See [docs/living-plan-and-waves.md](docs/living-plan-and-waves.md).

## Web Cockpit, MCP Server, Daemon & TypeScript SDK

TaskForge extends beyond the terminal while staying strictly local-first:

- **Local Web Cockpit (`127.0.0.1`):** run `tf ui` (or `/ui` in the REPL) for live SSE status, visual diffs, Living Plan wave tracking, Debate Council transcripts, and memory management.
- **MCP Server for IDEs:** run `tf mcp serve` to expose `taskforge_council`, `taskforge_blueprint`, `taskforge_memory`, `taskforge_run_direct`, `taskforge_checkpoints`, and `taskforge_status` to Cursor, VS Code, Claude Desktop, or Antigravity.
- **Daemon & Recurring Schedules:** automate periodic audits or CI checks with `tf schedule add 6h "@codex audit security"` and `tf daemon start --ui-port 4310`.
- **Programmatic TypeScript SDK:** drive pipelines, councils, blueprints, and memory from scripts via `TaskForgeClient`.
- **Multi-Repo & Local Ollama:** coordinate sibling repos with `/multirepo` and run air-gapped local models with `@ollama`.

See [docs/platform-integrations.md](docs/platform-integrations.md) for copy-pasteable MCP configs, SDK snippets, Ollama setup, and lifecycle hooks.

## Repository instructions are part of the plan

TaskForge treats repository-authored guidance as project context, not incidental prose.

Supported instruction entry points currently include:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
```

TaskForge also discovers applicable top-level nested instruction files and follows local Markdown references while protecting against path traversal and oversized instruction payloads.

This is important for repositories that encode rules such as:

- directory ownership;
- architecture constraints;
- required verification commands;
- provider-specific guidance;
- “do not modify” areas;
- project-specific workflow rules.

More-specific path instructions refine root-level guidance.

## Recovery is evidence-driven

TaskForge does not want a failed task to become an infinite retry loop or a blind restart.

For the standard recoverable task path, the default recovery budget is:

```text
first failed attempt
      ↓
same agent repairs with concrete failure evidence
      ↓
second failed attempt
      ↓
reassign to another healthy agent with accumulated context
      ↓
recovery budget exhausted
      ↓
task becomes BLOCKED
      ↓
delivery stays disabled
```

When verification fails, the next attempt can receive the failing command, exit code, output, and candidate commit instead of starting from an empty description.

The default recovery budget is controlled by:

```yaml
verification:
  maxReworkCycles: 2
```

## Git and delivery model

TaskForge keeps execution away from your primary working tree.

Writable assignments run in isolated worktrees under:

```text
.taskforge/worktrees/
```

Successful task commits are integrated into a run-specific branch. Delivery is a separate step.

```text
agent worktree
     ↓
completion gate
     ↓
verification
     ↓
task integration
     ↓
run branch
     ↓
/diff → /apply or /pr
```

A completed run does not silently merge itself into `main`.

## Interactive workflow

Start the control plane:

```bash
tf
```

Typical interaction:

```text
> analyze the payment retry path and fix duplicate processing

✦ Plan Proposal
  TASK-01  investigate retry/idempotency boundary
  TASK-02  implement fix and regression coverage
  TASK-03  review verification evidence

> yes
```

While agents work, TaskForge remains the cockpit. You can inspect tasks, stream output, focus an agent, answer interactions, or cancel/reassign work.

When the run is complete:

```text
/diff
/pr
```

For a detailed walkthrough, see [docs/usage.md](docs/usage.md).

## Interactive command reference

The README intentionally lists the complete public slash-command catalog. The repository test suite checks this table against the CLI command menu.

| Command | Purpose |
| --- | --- |
| `/help` | Display the complete command reference |
| `/health` | Inspect Router, agents, provider quota, and local database health |
| `/plan` | Inspect the current proposed or active plan |
| `/blueprint` | Create, inspect, refine, or advance a domain-agnostic Living Plan (`.taskforge/plan.md`) across execution waves (`/blueprint [goal\|next\|refine <text>\|reset]`) |
| `/council` | Convene a 3-round Multi-Agent Solution Debate Council (`/council [@a @b] <problem>`): independent proposals, dedicated per-solution cross-critiques, proponent refinements, interactive follow-up rounds, and 1-Enter handoff |
| `/tdd` | Adversarial Multi-Agent TDD loop (`/tdd [@tester -> @implementer] <spec>`): Agent A writes failing tests (Red), Agent B implements until passing (Green) |
| `/memory` | View or manage durable cross-agent project memory (`.taskforge/memory.md`) shared by all agents (`/memory [add <text>\|remove <#>\|clear]`) |
| `/compact` | Compact older Direct Mode conversation turns into a dense rolling summary without losing key decisions |
| `/skills` | List reusable project skills discovered across `.taskforge/skills/`, `.claude/commands/`, and `.agents/skills/` |
| `/skill` | Run a reusable project skill with any agent (`/skill <name> [@codex\|@agy\|@claude\|@all] [args]`, or directly `/<name> [args]`) |
| `/bg` | List or inspect asynchronous background jobs started with `& <command>` |
| `/fix-ci` | Fetch failing GitHub Actions CI logs via `gh` and dispatch a targeted fix |
| `/review-pr` | Run an independent multi-agent review on a GitHub Pull Request (`/review-pr [#number]`) with 1-Enter comment posting |
| `/issue` | Fetch a GitHub Issue (`/issue <#number>`) into Orchestrated Planning, `/blueprint`, or `/council` |
| `/ui` | Start or stop the strictly-local Web Cockpit (`127.0.0.1`) with live SSE updates, visual diff viewer, Living Plan tracker, and Debate Council browser (also `tf ui`) |
| `/schedule` | Manage recurring scheduled automations (`/schedule [list\|add <interval> <cmd>\|remove <id>\|run <id>]`, also `tf schedule` & `tf daemon`) |
| `/voice` | Capture and transcribe local voice prompts via `sox` + `whisper` / `TASKFORGE_VOICE_CMD` (`/voice [seconds]`) |
| `/multirepo` | Coordinate linked sibling repositories (`/multirepo [status\|init <paths...>\|branch <name>]`) |
| `/runs` | List past execution runs and delivery status |
| `/inspect` | Inspect run → task → assignment history; accepts an optional run id |
| `/tasks` | Show task and assignment status; accepts an optional task id |
| `/status` | Open the full TUI dashboard |
| `/agents` | Show detected agent harnesses and availability; `/agents reset <id>` forgets a recorded failure (also `tf agents reset <id>`) |
| `/use` | Switch direct chat target (`/use <claude\|codex\|agy\|all\|auto>`); you can also use `@claude`, `@codex`, `@agy`, `@all`, `@codex -> @agy` (implement→review handoff), `@codex <-> @agy` (2-round debate), `#file` autocomplete, or `!cmd` |
| `/model` | Show or set per-agent model and reasoning effort (`/model <agent> <model> [effort]`, `/model <agent> effort <level>`, `/model <agent> reset`); saved to `.taskforge/config.yaml` and active immediately |
| `/checkpoints` | List automatic Direct Mode working-tree checkpoints available for instant `/undo` |
| `/stream` | Enter live output; accepts an optional task id |
| `/focus` | Focus one active agent by index, for example `/focus 2` |
| `/back` | Leave agent Focus Mode |
| `/raw` | Show persisted raw provider output; accepts an optional agent index |
| `/pending` | Show interactions waiting for human approval |
| `/approve` | Approve the current plan or a pending interaction |
| `/deny` | Deny a pending interaction |
| `/reject` | Reject the current plan with optional feedback |
| `/constraint` | Add a constraint to the current plan |
| `/reassign` | Reassign work to another healthy agent |
| `/cancel` | Cancel the active run or one active assignment |
| `/pause` | Pause orchestrator execution |
| `/unpause` | Continue a paused execution (`/resume` still works; it is not the same as `tf resume`) |
| `/fix` | Repair what blocked a run (link a missing `.env`, start the database service) and continue it; pressing Enter accepts the suggestion |
| `/retry` | Continue a failed, cancelled or interrupted run (same as `tf resume`); pressing Enter accepts the suggested retry |
| `/clear` | Start fresh: earlier runs stop being used as context for new requests |
| `/cost` | Show token usage and cost telemetry |
| `/stats` | Show execution and orchestration efficiency metrics |
| `/diff` | Inspect changes from a completed run; accepts an optional run id |
| `/undo` | Undo the last Direct Mode edit (instant checkpoint restore) or the last applied orchestrated run with a revert commit |
| `/answer` | Answer a question an agent is waiting on (`/answer [request-id] <text>`); `/approve` and `/deny` stay for permissions |
| `/workflow` | Show or set the Git workflow (`trunk`, `github-flow`, `gitflow`, `current-branch`); saved to `.taskforge/config.yaml` with its comments kept |
| `/apply` | Apply a completed run to its target branch |
| `/pr` | Create a pull request for a completed run |
| `/discard` | Keep the integration branch without applying delivery |
| `/clean` | Clean temporary worktrees and branches |
| `/exit` | Exit the interactive session |

Type `/` inside the REPL to open the interactive command menu.

## Headless usage

The REPL is the primary TaskForge experience, but automation is also supported.

```bash
# Full orchestration pipeline
tf run "Fix memory leak in websocket reconnection"

# Headless execution
tf exec "Add regression coverage for checkout retries" --yes --concurrency 2

# Import a GitHub issue
tf issue 123

# Continue an interrupted, cancelled or failed run
tf resume run-<id>

# Inspect previous runs
tf runs
tf inspect run-<id>
tf inspect run-<id> --json

# Delivery
tf apply run-<id>
tf pr create run-<id> --base main

# Optional per-project config (shows the file before writing it)
tf init

# Local Web Cockpit, IDE MCP server, daemon & scheduled automations
tf ui --port 4310
tf mcp serve
tf schedule add 6h "@codex audit recent commits for security regressions"
tf daemon start --ui-port 4310

# Local offline BM25 repository index & insights
tf index "payment retry"
tf insights

# Diagnostics and cleanup
tf doctor
tf health
tf clean
```

See [docs/usage.md](docs/usage.md#headless-and-automation) for the operational differences between interactive and headless execution.

## Configuration

TaskForge resolves project configuration from:

```text
.taskforge/config.yaml
```

and global configuration from:

```text
~/.taskforge/config.yaml
```

A typical project configuration looks like:

```yaml
router:
  provider: openai
  model: gpt-4o-mini
  fallback: static

execution:
  maxParallelTasks: 3
  defaultTimeoutMinutes: 30

collaboration:
  maxAgentsPerTask: 3

agents:
  claude:
    enabled: true
    model: claude-sonnet-4-6
    effort: high
  codex:
    enabled: true
    maxParallel: 2
    model: o3
    effort: high
  agy:
    enabled: true
  ollama:
    enabled: true
    model: qwen2.5-coder:latest

verification:
  tests: true
  lint: true
  typecheck: true
  review: true
  maxReworkCycles: 2

hooks:
  afterDirectEdit: "pnpm prettier --write $(git diff --name-only)"
  onRunComplete: "echo 'Run finished'"
  timeoutSeconds: 30

notifications:
  enabled: true
  sound: false
```

### Optional OpenAI router

TaskForge can use an OpenAI-backed planner/router for richer decomposition and staffing decisions.

```bash
export TASKFORGE_OPENAI_API_KEY="..."
```

If a valid key is not available, TaskForge can use its deterministic/static fallback instead of refusing to start.

Run:

```bash
tf doctor
```

to inspect your local setup.

### Optional OpenAI-compatible gateway (FreeLLMAPI)

TaskForge can use a local OpenAI-compatible gateway for **planning, intent classification, and agent staffing**, without changing the interactive `tf` experience. This is complementary to TaskForge's task decomposition, parallel scheduling, worktrees, verification, and explicit delivery.

After installing and configuring [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), set its unified API key in your shell:

```bash
export TASKFORGE_OPENAI_API_KEY="<your FreeLLMAPI unified API key>"
```

Then add this to `.taskforge/config.yaml` or `~/.taskforge/config.yaml`:

```yaml
router:
  provider: openai
  baseUrl: http://localhost:3001/v1
  model: auto
```

Launch `tf` as usual. The endpoint is also configurable with `TASKFORGE_OPENAI_BASE_URL` (higher priority than `router.baseUrl`). The gateway must support OpenAI-style `/v1/chat/completions` with JSON-schema structured responses and `/v1/models` for health checks. A model/profile such as `auto` is interpreted by the gateway, not TaskForge.

**Credential safety:** For non-default endpoints, TaskForge requires an explicitly configured key (`TASKFORGE_OPENAI_API_KEY` or `router.apiKey`). It will **not** forward an unrelated global `OPENAI_API_KEY` automatically. Keep keys outside committed project config whenever possible; use a local or HTTPS endpoint you trust.

**Agent processes are separate:** This integration routes the TaskForge *planner and staff selector*, not the underlying Claude Code/Codex/Antigravity CLIs. To route coding-agent inference through FreeLLMAPI as well, configure each compatible CLI using the [FreeLLMAPI agent setup guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/clients/01-agent-clients.md), then confirm it works with the TaskForge adapter before using it for writable tasks. Free model tiers and support for tool calls/structured output differ across upstream providers; TaskForge keeps its deterministic fallback if a planning/routing response is invalid.

## Architecture

TaskForge is a TypeScript monorepo with explicit control-plane boundaries.

```text
CLI / Conversation
       │
       ▼
Planner ──► Router ──► Task Graph
                    │
                    ▼
              Scheduler
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       Agent A   Agent B   Agent C
          │         │         │
          └──── worktrees ────┘
                    │
                    ▼
             Completion Gate
                    │
                    ▼
               Verification
                    │
                    ▼
               Integration
                    │
                    ▼
                 Delivery
```

The architectural rule is:

> AI interprets, proposes, negotiates, and reasons. Deterministic software controls authoritative state, process lifecycles, permissions, concurrency, Git state, verification, and repository integrity.

For deeper implementation notes, see:

- [Architecture phases 0–5](docs/architecture-phases-0-5.md)
- [Architecture phases 6–13](docs/architecture-phases-6-13.md)
- [Architecture phases 14–22](docs/architecture-phases-14-22.md)
- [Git branch lifecycle and hardening](docs/git-branch-lifecycle-and-hardening.md)
- [Interaction Gateway specification](docs/spec-v2-interaction-gateway.md)

## When TaskForge is a good fit

TaskForge covers the full spectrum from quick single-agent turns to multi-agent engineering runs:

- **Quick daily tasks (`auto` / Direct Mode):** ask questions, edit files with `#file` / `#image` context, switch models (`/model`), chain `@codex -> @claude`, or roll back instantly with `/undo`—all inside one terminal with shared `.taskforge/memory.md` and `/skills`.
- **Architecture & high-stakes decisions:** convene a 3-round `/council` across multiple independent agents before writing code.
- **Large features & greenfield builds:** plan iteratively in `.taskforge/plan.md` (`/blueprint`) and fan out Wave 2 modules across isolated Git worktrees with collision-free `.taskforge.env` ports.
- **Strict verification & controlled Git delivery:** enforce tests, linting, typechecking, scope boundaries, bounded evidence-driven recovery, and explicit `/diff` → `/apply` / `/pr` delivery.

## Current status

TaskForge is currently **v1.0.0-rc.1 (release candidate)** and undergoing real-agent pilot validation (see [docs/release-criteria-1.0.md](docs/release-criteria-1.0.md) and [docs/pilot.md](docs/pilot.md)). Until `1.0.0` is published to npm, install from source or Docker as shown in [Quick start](#quick-start).

It is already dogfooded on real repositories, but users should expect interfaces and configuration to evolve while the control plane is hardened.

Current emphasis:

- repository-aware planning;
- reliable multi-agent execution;
- live operator visibility;
- bounded recovery with evidence;
- completion and verification correctness;
- predictable Git delivery.

CI targets Node.js 22 and Node.js 24.

## Documentation

- [Direct Mode, Pipelines & Debate Council](docs/direct-mode-and-workflows.md) — `@agent`, `@a -> @b`, `@a <-> @b`, `--edit` + `mix`, `/tdd`, `/council`, `/undo`, `/model`, `/memory`, `/skills`, `&`, `/voice`, GitHub Autopilot
- [Living Plan & Wave Execution](docs/living-plan-and-waves.md) — `.taskforge/plan.md`, `/blueprint`, greenfield detection, deterministic Wave 2 fan-out, per-worktree `.taskforge.env` ports, Peer Mailbox & file locks
- [Platform Integrations](docs/platform-integrations.md) — `tf ui` Local Web Cockpit, `tf mcp serve` (Cursor / VS Code / Claude Desktop), `tf daemon` & `tf schedule`, `TaskForgeClient` TypeScript SDK, `@ollama`, lifecycle hooks, `/multirepo`
- [Usage guide](docs/usage.md) — end-to-end orchestrated workflow from setup to PR delivery
- [Pilot checklist (validate with real agents)](docs/pilot.md)
- [Release criteria for 1.0](docs/release-criteria-1.0.md)
- [Architecture phases 0–5](docs/architecture-phases-0-5.md)
- [Architecture phases 6–13](docs/architecture-phases-6-13.md)
- [Architecture phases 14–22](docs/architecture-phases-14-22.md)
- [Git branch lifecycle and hardening](docs/git-branch-lifecycle-and-hardening.md)
- [Interaction Gateway specification](docs/spec-v2-interaction-gateway.md)
- [Product engineering spec v2](taskforge-complete-product-engineering-spec-v2.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The full CI suite must remain green on Node.js 22 and Node.js 24.

## Contributing

Issues and pull requests are welcome. Please review:

- [CONTRIBUTING.md](CONTRIBUTING.md) — local setup, architecture boundaries, PR checklist, and release process
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards
- [SECURITY.md](SECURITY.md) — security model and private vulnerability reporting

For changes to the control plane, keep the core design boundary intact: model output may propose or interpret decisions, but authoritative execution state, permissions, Git behavior, verification, and repository integrity should remain deterministic.

When adding a public slash command, update the README command reference as well; CI verifies that the public command catalog stays documented.

## License

TaskForge is released under the [MIT License](LICENSE).
