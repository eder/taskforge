# TaskForge

<p align="center">
  <strong>One terminal. Multiple coding agents. One controlled engineering workflow.</strong>
</p>

<p align="center">
  Open-source control plane for coordinating Claude Code, Codex CLI, and Google Antigravity across planning, isolated execution, live supervision, recovery, verification, and Git delivery.
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

## Quick start

### Requirements

- Node.js 22+
- Git
- pnpm
- at least one supported coding-agent CLI installed and authenticated:
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) — `claude`
  - [OpenAI Codex CLI](https://github.com/openai/codex) — `codex`
  - [Google Antigravity](https://antigravity.google/) — `agy`

### Install from source

TaskForge is currently distributed from source.

```bash
git clone https://github.com/eder/taskforge.git
cd taskforge
pnpm install
pnpm build
npm link apps/cli
```

Then enter any Git repository:

```bash
cd /path/to/your-project
tf doctor
tf
```

Now describe the engineering outcome naturally:

```text
> fix the duplicate payment race condition and add regression coverage
```

TaskForge proposes a plan before writable execution. You can approve it, revise it conversationally, or add constraints before any delivery happens.

## What happens after a prompt

```text
You
 │
 │  "Fix the retry bug and add regression tests"
 ▼
TaskForge
 │
 ├─ reads repository context and project instructions
 ├─ classifies the execution intent
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
| Natural-language planning | Turns an engineering goal into structured tasks, dependencies, contracts, and acceptance criteria |
| Repository-aware instructions | Discovers applicable `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and referenced Markdown guidance for planning |
| Multi-agent routing | Chooses a minimum useful team based on availability, role fit, and task characteristics |
| Isolated execution | Runs writable assignments in separate Git worktrees |
| Live supervision | Streams agent activity and lets you inspect or focus active assignments from one terminal |
| Human-in-the-loop | Centralizes questions, permissions, confirmation, and authentication boundaries |
| Completion Gate | Separates “the process exited” from “the engineering task is complete” |
| Verification | Runs configured tests, linting, typechecking, review, and explicit task verification commands |
| Progressive recovery | Reuses failure evidence and candidate state before escalating to another agent |
| Explicit delivery | Keeps `/diff`, `/apply`, `/pr`, and `/discard` under human control |

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
| `/runs` | List past execution runs and delivery status |
| `/inspect [run-id]` | Inspect run → task → assignment history |
| `/tasks [task-id]` | Show task and assignment status |
| `/status` | Open the full TUI dashboard |
| `/agents` | Show detected agent harnesses and availability |
| `/stream [task-id]` | Enter live output for the active task or assignment |
| `/focus <n>` | Focus one active agent |
| `/back` | Leave agent Focus Mode |
| `/raw [n]` | Show persisted raw provider output |
| `/pending` | Show interactions waiting for human approval |
| `/approve [request-id] [scope]` | Approve the current plan or a pending interaction |
| `/deny [request-id]` | Deny a pending interaction |
| `/reject [feedback]` | Reject the current plan with feedback |
| `/constraint <text>` | Add a constraint to the current plan |
| `/reassign <task> [agent]` | Reassign work to another healthy agent |
| `/cancel [n]` | Cancel the active run or one active assignment |
| `/pause` | Pause orchestrator execution |
| `/resume` | Resume paused execution |
| `/cost` | Show token usage and cost telemetry |
| `/stats` | Show execution and orchestration efficiency metrics |
| `/diff [run-id]` | Inspect changes from a completed run |
| `/apply [run-id]` | Apply a completed run to its target branch |
| `/pr [run-id]` | Create a pull request for a completed run |
| `/discard [run-id]` | Keep the integration branch without applying delivery |
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

# Inspect previous runs
tf runs
tf inspect run-<id>
tf inspect run-<id> --json

# Delivery
tf apply run-<id>
tf pr create run-<id> --base main

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
  model: gpt-5.6-luna
  fallback: static

execution:
  maxParallelTasks: 3
  defaultTimeoutMinutes: 30

collaboration:
  maxAgentsPerTask: 3

verification:
  tests: true
  lint: true
  typecheck: true
  review: true
  maxReworkCycles: 2
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

TaskForge is useful when:

- one prompt is no longer enough to represent the engineering workflow;
- different tasks benefit from different coding agents or roles;
- you want isolated concurrent execution;
- you want live visibility without managing several terminals;
- you want verification and bounded recovery before delivery;
- your repository contains project instructions that should influence planning;
- you want a Git delivery boundary between autonomous execution and your target branch.

For a small edit where one agent already has everything it needs, using that coding agent directly may be simpler.

## Current status

TaskForge is currently **v0.1.0** and under active development.

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

- [Usage guide](docs/usage.md)
- [Architecture phases 0–5](docs/architecture-phases-0-5.md)
- [Architecture phases 6–13](docs/architecture-phases-6-13.md)
- [Architecture phases 14–22](docs/architecture-phases-14-22.md)
- [Git branch lifecycle and hardening](docs/git-branch-lifecycle-and-hardening.md)
- [Interaction Gateway specification](docs/spec-v2-interaction-gateway.md)
- [Product engineering spec v2](taskforge-complete-product-engineering-spec-v2.md)

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

Issues and pull requests are welcome.

For changes to the control plane, keep the core design boundary intact: model output may propose or interpret decisions, but authoritative execution state, permissions, Git behavior, verification, and repository integrity should remain deterministic.

When adding a public slash command, update the README command reference as well; CI verifies that the public command catalog stays documented.

## License

TaskForge is released under the [MIT License](LICENSE).
