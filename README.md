# TaskForge

<p align="center">
  <strong>Autonomous Multi-Agent Coordination & Git-Worktree Engine for Software Engineering</strong>
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-v5.7-blue.svg" alt="TypeScript"></a>
  <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/monorepo-pnpm%20workspaces-orange.svg" alt="pnpm"></a>
  <a href="https://sqlite.org/"><img src="https://img.shields.io/badge/persistence-SQLite%20(Node%20Native)-lightgrey.svg" alt="SQLite"></a>
</p>

---

## Overview

**TaskForge** is an open-source, conversational control plane that coordinates existing, best-of-breed AI coding agents—such as **Claude Code**, **OpenAI Codex CLI**, and **Google Antigravity**—into self-organizing, collaborative software engineering teams.

Rather than attempting to reinvent code-editing models or replace specialized developer harnesses, TaskForge acts as an authoritative, deterministic orchestration layer. Developers converse with an interactive terminal REPL, describing high-level engineering objectives. TaskForge decomposes those objectives into structured task graphs (DAGs), negotiates precise task contracts, spawns isolated Git worktree sandboxes, schedules agents based on capabilities and token quotas, verifies results through rigorous automated test gates, and integrates validated changes cleanly into the codebase.

### The Core Architectural Invariant

> **AI interprets, proposes, negotiates, and reasons; deterministic software controls authoritative state, process lifecycles, and repository integrity.**

---

## Architectural Pillars

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TASKFORGE CONTROL PLANE                            │
│                                                                             │
│  ┌───────────────────────┐             ┌─────────────────────────────────┐  │
│  │   Interactive REPL    │◄───────────►│       Operator Agent            │  │
│  │  (Persistent Shell)   │             │   (Goal Clarification & Intent) │  │
│  └──────────┬────────────┘             └────────────────┬────────────────┘  │
│             │                                           │                   │
│             ▼                                           ▼                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     Router & Team Staffing Engine                     │  │
│  │   - OpenAI Structured Outputs (Advisory Minimum Sufficient Team)     │  │
│  │   - Token & Quota-Aware Routing (Cooldown & Rate-Limit Tracking)      │  │
│  └──────────────────────────────────┬────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     Deterministic Run Scheduler                       │  │
│  │   - Task Graph (DAG) Resolution & Dependency Management               │  │
│  │   - Preflight Contract Negotiation (Scopes, Invariants, Gates)        │  │
│  │   - Reactive Failover & Worker Reassignment                           │  │
│  └──────┬───────────────────────────┬───────────────────────────┬────────┘  │
│         │                           │                           │           │
│         ▼                           ▼                           ▼           │
│  ┌──────────────┐            ┌──────────────┐            ┌──────────────┐   │
│  │ Claude Code  │            │  Codex CLI   │            │ Google Antigr│   │
│  │   Adapter    │            │   Adapter    │            │ Adapter(agy) │   │
│  └──────┬───────┘            └──────┬───────┘            └──────┬───────┘   │
│         │                           │                           │           │
│         ▼                           ▼                           ▼           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                 Ephemeral Git Worktrees (.taskforge/)                │   │
│  │   - Branch-Per-Assignment Isolation (No working tree contamination)   │   │
│  │   - Strict File-Scope Sandboxing & Boundary Enforcement              │   │
│  └──────────────────────────────────┬───────────────────────────────────┘   │
│                                     │                                       │
│                                     ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Autonomous Verification Pipeline                  │   │
│  │   - Deterministic Gates: Unit Tests, Linters, Typechecking           │   │
│  │   - Contract Diff Validation & Audit Trail Invariants                │   │
│  │   - Bounded Automated Rework Cycles                                  │   │
│  └──────────────────────────────────┬───────────────────────────────────┘   │
│                                     │                                       │
│                                     ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                   Integration & Persistence Engine                   │   │
│  │   - Atomic Squash & Merge to Integration Branch                      │   │
│  │   - Audit Event Sourcing & Telemetry Store (SQLite)                  │   │
│  │   - GitHub Workflow Service (Pull Request & Audit Evidence Creation) │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Harness Agnostic**: Zero vendor lock-in. Uses standard system binaries (`claude`, `codex`, `agy`) already authenticated on your machine.
2. **True Git Worktree Sandboxing**: Every agent operates in an isolated worktree (`.taskforge/worktrees/<task-id>`) checked out to a temporary branch. The primary working copy is never mutated during execution.
3. **Formal Preflight Contracts**: Tasks cannot execute until bounded by an explicit contract detailing objective, allowed files, forbidden patterns, and acceptance tests.
4. **Minimum Sufficient Team**: An advisory Router Agent uses structured LLM outputs to staff only the necessary workers (single developer, parallel investigators, or independent reviewer gates).
5. **Quota & Token Intelligence**: Telemetry monitors CLI outputs for usage limits and HTTP 429s in real time, auto-expiring cooldowns and skipping quota-exhausted models during routing.
6. **Authoritative State & Persistence**: Backed by a high-throughput, native Node 22 SQLite database (`.taskforge/taskforge.db`) capturing runs, tasks, assignments, telemetry, and audit events.

---

## Monorepo Architecture

TaskForge is engineered as a clean, highly modular TypeScript monorepo managed via `pnpm` workspaces:

```
taskforge/
├── apps/
│   └── cli/                  # Command-line interface and binary entrypoint (`tf`)
└── packages/
    ├── core/                 # Domain entities, TaskGraph DAG, contracts, and events
    ├── agents/               # CLI agent adapters, harness registry, and quota tracker
    ├── router/               # Team routing, OpenAI structured outputs, adaptive selector
    ├── planner/              # Goal decomposition into executable task dependency graphs
    ├── scheduler/            # Deterministic execution engine, DAG walker, and failover
    ├── workspace/            # Git service, worktree sandbox manager, repository profiler
    ├── verification/         # Automated test runners, linters, typechecks, diff auditors
    ├── integration/          # Branch integration, conflict resolver, GitHub PR creation
    ├── negotiation/          # Preflight contract negotiation and amendment protocol
    ├── collaboration/        # Multi-agent peer messaging, review loops, and synthesis
    ├── operator/             # Conversational intent router, goal clarification engine
    ├── conversation/         # Terminal REPL, persistent bottom prompt, TUI dashboard
    ├── persistence/          # Native SQLite schema, repositories, and event sourcing
    ├── telemetry/            # Token consumption estimator, cost accounting, duration metrics
    ├── execution/            # Sandboxed subprocess runner with timeout and stream buffering
    ├── plugins/              # Extensible plugin system (e.g., Enterprise Compliance / ECC)
    └── shared/               # Universal configuration, logger, error models, and schemas
```

---

## Installation & Prerequisites

### Prerequisites

- **Node.js**: `v22.0.0` or higher (uses native Node SQLite support).
- **Git**: `v2.38.0` or higher (with native `git worktree` support).
- **pnpm**: `v9.0.0` or higher.
- **Agent Harnesses**: At least one supported CLI installed on your `$PATH`:
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) (`claude`)
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Google Antigravity](https://antigravity.google/) (`agy`)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/eder/taskforge.git
cd taskforge

# 2. Install dependencies
pnpm install

# 3. Build all workspace packages
pnpm build

# 4. Link CLI globally (optional)
npm link apps/cli
```

### Environment Configuration

Configure your OpenAI API key for advisory routing, contract synthesis, and planning:

```bash
export OPENAI_API_KEY="sk-proj-..."
```

---

## Quickstart

### 1. Run Health Check (`tf doctor`)

Verify your environment, detected agent harnesses, Git repository status, and SQLite support:

```bash
$ tf doctor

  ✦ TaskForge Environment Doctor
  System and harness diagnostic verification

  Node.js Runtime:    v22.14.0 (>= 22.0.0 required) - ✔ OK
  Git Repository:     ✔ OK (main • a716eb5 • clean)
  SQLite Database:    ✔ OK
  Workspace Profile:  Node.js (TypeScript) project with 42 source files

  Agent Harness Detection:
    ● Claude Code        [claude ] ready
    ● Codex CLI          [codex  ] ready
    ● Google Antigravity [agy    ] ready

  ✔ Diagnostic complete. Everything ready!
```

### 2. Launch the Interactive REPL (`tf`) — Primary Experience

The interactive terminal is the **flagship interface** of TaskForge. Instead of a one-shot CLI script, `tf` provides an interactive, full-duplex conversational terminal session where developers converse with the multi-agent control plane, review and approve task plans, monitor real-time worker execution across Git worktrees, and steer integration.

#### Terminal Architecture & Layout

The terminal operates with an advanced **split viewport layout**:

- **Scroll Buffer (Top)**: Real-time agent outputs, structured task cards, verification progress, and conversational history stream upward cleanly without flickering.
- **Persistent Bottom Prompt (`> `)**: The input prompt is always anchored to the bottom row of your terminal, remaining immediately accessible even when agents generate extensive test output or diffs.

```bash
$ tf
```

---

#### Complete Interactive Lifecycle Walkthrough

##### Phase 1: Environment & Agent Readiness Detection

Upon launching `tf`, TaskForge immediately profiles your workspace, analyzes the Git repository, and detects available coding-agent harnesses along with live quota and rate-limit health:

```text
 ╭─────────────────────────────────────────────────────────────────╮
 │  ✦ TaskForge Control Plane                              v0.1.0  │
 │  Autonomous multi-agent coordination & git-worktree engine      │
 ╰─────────────────────────────────────────────────────────────────╯

  Repository  /Users/developer/projects/payments-service
  Git Status  main (e89f10a) • clean

  Agents
    ● Claude Code        [claude ] ready
    ● Codex CLI          [codex  ] ready
    ● Google Antigravity [agy    ] ready

  Router      OpenAI       ● ready (OpenAI gpt-4o-mini)
  ECC         ○ not detected
 ─────────────────────────────────────────────────────────────────

> █
```

##### Phase 2: Natural Language Objective

Type an objective in plain natural language. You can specify architectural goals, bug investigations, or refactoring constraints:

```text
> investigate race condition in Stripe webhook and ensure idempotency with redis tests
```

##### Phase 3: Advisory Plan Proposal & Negotiation

The advisory Router synthesizes the request, computes the **minimum sufficient team**, estimates token footprints, and bounds the task with an explicit contract. You are presented with a structured plan before any files are modified:

```text
✦ Plan Proposal
Understood. Recommended strategy: PARALLEL (Complexity: high, Risk: high).
Suggested team: Claude Code (architecture_reviewer), Codex CLI (reproduction_engineer), Google Antigravity (researcher).
Estimated tokens: ~4,200 tokens.
Total of 2 structured tasks:
  1. 🛠 [FEATURE] Implement Redis-backed idempotency lock in Stripe webhook (~2,400 tokens)
  2. 🧪 [TEST] Add concurrent integration tests reproducing duplicate charge (~1,800 tokens)

  ● Do you want me to execute? (type "yes", "y" or "/approve" to start)

> yes
```

##### Phase 4: Live Multi-Agent Execution in Ephemeral Worktrees

Once approved, the deterministic scheduler spawns isolated Git worktrees under `.taskforge/worktrees/`. Agents work strictly in isolation without clobbering each other or your main working copy. Live execution streams directly into the upper viewport:

```text
╭── ✦ TaskForge Execution ───────────────────────────────────────╮
│  ✔ Plan approved. Starting execution...
│  ℹ Starting TaskForge orchestrator run: run-1789831200000
│  ⚡ Scheduling 2 tasks across worktrees...
│
│  ✦ [TASK-01] Assigned to Claude Code: "Implement Redis-backed idempotency lock"
│    📁 Created isolated worktree (taskforge/TASK-01/asgn-TASK-01-43e83a0f)
│    ⚡ Agent Claude Code executing...
│    ✔ Agent Claude Code completed (status: success in 42.1s)
│    🧪 Running verification checks (pnpm test, pnpm lint, tsc)...
│    ✔ Verified successfully ✓
│
│  ✦ [TASK-02] Assigned to Codex CLI: "Add concurrent integration tests"
│    📁 Created isolated worktree (taskforge/TASK-02/asgn-TASK-02-b8f90c12)
│    ⚡ Agent Codex CLI executing...
│    ✔ Agent Codex CLI completed (status: success in 28.4s)
│    🧪 Running verification checks...
│    ✔ Verified successfully ✓
│
│  ✔ Integration branch ready: taskforge/integration-run-1789831200000
╰────────────────────────────────────────────────────────────────╯

> █
```

##### Phase 5: Continuous Conversation & Follow-up

The session remains active! You can ask follow-up questions, inspect metrics, or direct next steps:

```text
> create a pull request with the audit summary targeting main
```

TaskForge generates the PR on GitHub complete with verified audit logs, test execution evidence, and token cost attribution.

---

#### Interactive Slash Commands & Live Autocomplete

Type `/` at the prompt to trigger the **interactive command menu**. The palette automatically filters as you type (for example, typing `/e` instantly selects `/exit`), and you can navigate with the `Up`/`Down` arrow keys and press `Tab` or `Enter` to auto-complete:

```text
  ┌─────────────────────────────────────────────────────────────┐
  │  /exit       Exit interactive session                       │
  │  /help       Display command reference and guide            │
  │  /plan       Inspect current proposed or active plan        │
  │  /tasks      List status of all tasks in current run        │
  │  /status     Open full visual TUI dashboard                 │
  │  /agents     Inspect detected AI agent harnesses & quotas   │
  │  /cost       Show tokens and financial cost report          │
  │  /stats      Show run execution metrics                     │
  │  /clean      Clean temporary worktrees and branches         │
  │  /pending    View interactions awaiting approval            │
  │  /approve    Approve plan or pending interaction            │
  │  /deny       Deny pending interaction                       │
  │  /pause      Pause orchestrator execution                   │
  │  /resume     Resume paused execution                        │
  └─────────────────────────────────────────────────────────────┘
> /█
```

##### Command Reference

| Slash Command        | Description                                                                          |
| :------------------- | :----------------------------------------------------------------------------------- |
| `/agents`            | View detected AI harnesses, binary paths, readiness, and real-time quota cooldowns   |
| `/tasks`             | List all tasks in the current run DAG, dependencies, and execution status            |
| `/status` / `/dash`  | Open the full-screen visual dashboard with repository, run, and agent metrics        |
| `/cost`              | Display detailed token consumption breakdown (input, output) and estimated USD costs |
| `/stats`             | View performance analytics, duration per agent, and verification cycle metrics       |
| `/plan`              | Re-display the currently active or proposed task dependency graph                    |
| `/approve`           | Confirm and launch the proposed execution plan or pending interaction                |
| `/reject`            | Reject the proposed plan and provide conversational steering feedback                |
| `/deny`              | Deny an agent's request for out-of-scope permissions or destructive commands         |
| `/pause` / `/resume` | Pause and resume running agent workers on the fly                                    |
| `/clean`             | Prune all orphaned Git worktrees and stale assignment branches                       |
| `/help`              | Print complete interactive guide and keybindings                                     |
| `/exit`              | Safely terminate the session, prune ephemeral resources, and close SQLite handles    |

#### Terminal Navigation & Keybindings

- **`Up` / `Down`**: Navigate through previous command history (or move selection inside the `/` slash menu).
- **`Left` / `Right`**: Move cursor inline for rapid prompt editing.
- **`Backspace` / `Delete`**: Edit current prompt buffer.
- **`Tab`**: Auto-complete matching slash command from the popup menu.
- **`Ctrl + C`**: Interrupt and cancel currently running agent execution or plan; if idle, safely prompts to exit.
- **`Esc`**: Dismiss the slash command autocomplete popup.

---

## Headless & Automation Mode

For CI/CD pipelines, scripted batch operations, or scheduled workflows, TaskForge provides non-interactive CLI commands:

### Direct Autonomous Execution

```bash
# Execute an objective with auto-confirmation and concurrency limits
tf exec "Fix memory leak in websocket reconnection handler" --yes --concurrency 2

# Run full planning, scheduling, verification, and integration pipeline
tf run "Migrate persistence layer from commonjs to ESM"
```

### GitHub Workflow Integration

```bash
# Import an existing GitHub issue and spawn a coordinated team to resolve it
tf issue 42

# Create a pull request containing automated audit evidence and verification logs
tf pr create --base main
```

### Run Inspection & Cost Auditing

```bash
# Inspect structured run state as human-readable report
tf inspect run-1789794456374

# Export run telemetry, tasks, and interaction events as JSON
tf inspect run-1789794456374 --json

# Display token usage and cost breakdown
tf cost run-1789794456374
```

### Workspace Sanitation

```bash
# Clean up orphaned worktrees and stale assignment branches
tf clean
```

---

## Configuration

TaskForge is pre-configured with robust defaults, but behavior can be customized via `.taskforge/config.json` or `taskforge.config.yaml` in your repository root:

```yaml
# taskforge.config.yaml
execution:
  maxParallelTasks: 3
  defaultTimeoutMinutes: 30
  worktreesDir: .taskforge/worktrees
  databasePath: .taskforge/taskforge.db
  runsDir: .taskforge/runs

collaboration:
  maxAgentsPerTask: 3
  maxMessagesPerRound: 6
  maxRounds: 3

agents:
  claude:
    enabled: true
    maxParallel: 2
  codex:
    enabled: true
    maxParallel: 2
  agy:
    enabled: true
    maxParallel: 1

verification:
  tests: true
  lint: true
  typecheck: true
  review: true
  maxReworkCycles: 2

router:
  provider: openai
  model: gpt-4o-mini
```

---

## Security & Sandboxing Model

- **Isolation Guarantee**: Agents execute exclusively inside isolated Git worktrees (`.taskforge/worktrees/`). Code modifications never touch the active working branch until all automated verification checks pass.
- **Scope Boundary Enforcement**: Contracts establish strict allowed paths (e.g. `src/auth/**`). File modifications outside the negotiated scope fail pre-merge verification audits.
- **Destructive Command Protection**: TaskForge execution engines intercept subprocess commands, preventing dangerous operations such as arbitrary root modifications (`rm -rf /`), forced Git pushes, or untracked file deletion.
- **Audit Trail**: Every interaction, contract amendment, agent stdout/stderr stream, and test result is immutably recorded in SQLite.

---

## Contributing & Development

We welcome contributions! TaskForge is built with strict TypeScript typings and comprehensive test coverage.

### Development Workflow

```bash
# Run monorepo typecheck
pnpm typecheck

# Run linter
pnpm lint

# Run all unit and integration test suites
pnpm test

# Run tests in watch mode
pnpm test:watch
```

### Monorepo Conventions

- **Zero circular dependencies**: Verified via package boundaries.
- **Deterministic Unit Tests**: Use `FakeAgent` and in-memory SQLite (`:memory:`) for lightning-fast, reproducible tests without requiring API keys or external binaries.
- **Format with Prettier**: Run `pnpm format` before opening pull requests.

---

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for complete details.

Copyright (c) 2026 Eder Eduardo and TaskForge Contributors.
