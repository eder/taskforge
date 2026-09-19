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

### 2. Launch the Interactive REPL (`tf`)

Launch the conversational shell from the root of any Git repository:

```bash
$ tf
```

The interactive terminal features a **persistent bottom prompt**, full ANSI styling, command history navigation (Up/Down), autocomplete, and real-time agent output streaming.

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

  Router      OpenAI       ● ready

> add idempotency keys to Stripe webhook handler and write tests
```

#### Slash Commands

Inside the REPL, type `/` to access built-in deterministic commands:

| Command   | Description                                                      |
| :-------- | :--------------------------------------------------------------- |
| `/agents` | Inspect detected agent harnesses, binary paths, and quota health |
| `/tasks`  | View active and completed tasks in the current run graph         |
| `/status` | Display visual dashboard with repository, run, and agent state   |
| `/cost`   | View token usage and dollar cost attribution for recent runs     |
| `/pause`  | Pause execution of in-flight tasks                               |
| `/resume` | Resume paused task execution                                     |
| `/help`   | View interactive command palette                                 |
| `/exit`   | Terminate session and clean up transient resources               |

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
