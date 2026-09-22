# TaskForge

<p align="center">
  <strong>One terminal. Multiple coding agents. One controlled engineering workflow.</strong>
</p>

<p align="center">
  Open-source control plane for coordinating Claude Code, Codex CLI, and Google Antigravity with planning, isolated execution, live supervision, failover, verification, and Git delivery.
</p>

<p align="center">
  <a href="https://github.com/eder/taskforge/actions/workflows/ci.yml"><img src="https://github.com/eder/taskforge/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-blue.svg" alt="TypeScript"></a>
</p>

---

## Why TaskForge exists

Using one coding agent is easy.

Using several agents on a real codebase is not.

Once you have Claude Code, Codex, Antigravity, or other strong coding harnesses available, a new problem appears:

- Which agent should handle this task?
- Should one agent implement while another reviews?
- Can investigations run in parallel without touching the same working tree?
- What happens when a provider hits quota halfway through a run?
- How do you see what every agent is doing without opening several terminals?
- What happens when an agent needs a human decision?
- How do you know that a process that exited successfully actually completed the engineering task?
- Which changes are verified and safe to deliver?

Without an orchestration layer, **you become the orchestration layer**.

TaskForge is designed to take that coordination work off your hands.

> **TaskForge turns coding agents into an engineering team you can supervise.**

You describe the outcome you want. TaskForge plans the work, chooses the minimum team it needs, gives agents isolated Git workspaces, watches execution live, handles provider failures, asks you only when a real human decision is required, verifies the result, and prepares a clean delivery.

---

## What TaskForge does

```text
You
 │
 │  "Fix the duplicate payment race condition and add regression tests"
 ▼
TaskForge
 │
 ├─ understands the objective
 ├─ decomposes it into a task graph
 ├─ chooses the minimum team needed
 ├─ assigns isolated Git worktrees
 │
 ├─ Codex ───────────────► implementation
 ├─ Claude Code ─────────► review
 └─ Antigravity ─────────► investigation
 │
 ├─ streams execution into one cockpit
 ├─ handles quota/failover and reassignment
 ├─ pauses only when human input is actually required
 ├─ runs completion and verification gates
 └─ integrates verified work into a run branch
                    │
                    ▼
             /diff  /apply  /pr
```

TaskForge does **not** replace coding agents.

Claude Code, Codex, and Antigravity remain responsible for understanding and changing code. TaskForge sits above them and manages the engineering workflow around those agents:

- planning and task decomposition;
- team selection and role assignment;
- isolated Git worktrees;
- concurrent and collaborative execution;
- human-in-the-loop decisions;
- quota awareness, failover, and reassignment;
- independent review;
- completion evidence and verification;
- integration and delivery.

Think of the coding agents as engineers and TaskForge as the control plane around the engineering team.

---

## A normal day with TaskForge

Start TaskForge inside a repository:

```bash
tf
```

TaskForge detects the repository and the coding agents already installed on your machine:

```text
╭─────────────────────────────────────────────────────────────────╮
│  ✦ TaskForge Control Plane                              v0.1.0  │
│  Multi-agent engineering control plane                         │
╰─────────────────────────────────────────────────────────────────╯

Repository  ~/projects/payments-service
Git Status  main (e89f10a) • clean

Agents
  ● Claude Code        ready
  ● Codex CLI          ready
  ● Google Antigravity ready

Router      OpenAI     ● ready
─────────────────────────────────────────────────────────────────

> fix the duplicate payment bug and add a regression test
```

TaskForge proposes a plan before execution:

```text
✦ Plan Proposal

Goal: fix the duplicate payment bug and add a regression test

Strategy: PARALLEL
Team:
  Codex CLI          reproduction_engineer
  Claude Code        architecture_reviewer

Tasks:
  1. Reproduce and isolate the duplicate-payment path
  2. Implement the fix and regression test

Execute? yes / revise
```

Approve it:

```text
> yes
```

Then keep using the same terminal while the team works:

```text
TASK-01  [Codex CLI]     reproducing concurrent webhook delivery
TASK-01  [Claude Code]   reviewing payment/ledger boundaries

Codex found concurrent processing before the idempotency guard.
Claude confirmed the guard belongs before ledger mutation.

TASK-02  [Codex CLI]     implementing fix and regression test
```

If a provider becomes unavailable, TaskForge can recover the role instead of immediately failing the run:

```text
╭─ PROVIDER FAILOVER ─────────────────────────────────────────────╮
│ ⚠ Provider unavailable                                         │
│ Task:      TASK-01                                              │
│ Role:      researcher                                           │
│ Failed:    Google Antigravity                                   │
│ Reason:    quota exhausted                                      │
│                                                                │
│ ↻ Searching for a healthy replacement...                       │
╰─────────────────────────────────────────────────────────────────╯

↻ Reassigning researcher → Claude Code

╭─ PROVIDER RECOVERED ────────────────────────────────────────────╮
│ Google Antigravity unavailable                                  │
│ ↻ researcher reassigned → Claude Code                           │
│ ✓ Recovered                                                     │
╰─────────────────────────────────────────────────────────────────╯
```

If an agent really needs you, the request becomes explicit instead of disappearing into logs:

```text
╭─ ACTION REQUIRED ───────────────────────────────────────────────╮
│ ▲ Human decision needed                                        │
│                                                                │
│ Agent:     Codex CLI (implementer)                              │
│ Task:      TASK-02 — Implement idempotency fix                  │
│ Action:    install → ioredis                                    │
│ Why:       required by the implementation                       │
│                                                                │
│ /approve req-42 once     allow once                             │
│ /approve req-42 task     allow for this task                    │
│ /deny req-42             deny                                   │
│ /pending                 view context                           │
╰─────────────────────────────────────────────────────────────────╯
```

When the run finishes:

```text
✔ Implementation complete
✔ Verification passed
✔ Review passed

Delivery    READY TO APPLY

/diff       inspect changes
/apply      apply to target branch
/pr         create a pull request
/discard    keep the run branch without applying
```

The key idea is simple: **agents can work autonomously inside TaskForge, but delivery remains explicit and inspectable.**

---

## Why not just use Claude Code or Codex directly?

You should use them directly when one agent and one task are enough.

TaskForge becomes useful when the engineering workflow is larger than one prompt:

| Direct coding agent | TaskForge |
| --- | --- |
| One agent session | Multiple agents and roles |
| You choose who works | Router chooses a minimum sufficient team |
| You manage parallel terminals | One live cockpit |
| You manage branches/worktrees | Isolated workspaces are created automatically |
| Provider failure interrupts you | Quota-aware failover can reassign work |
| Permissions appear inside each harness | TaskForge surfaces human decisions centrally |
| Exit code often means "process finished" | Completion Gate asks whether the engineering task was actually completed |
| You manually combine results | Verified results are integrated into a run branch |
| You decide how to deliver | `/diff`, `/apply`, `/pr`, `/discard` |

TaskForge is intentionally harness-agnostic: it orchestrates existing tools instead of trying to become another coding model or editor.

---

## What TaskForge takes care of

### Planning

Natural-language goals are turned into structured task graphs with dependencies, contracts, acceptance criteria, and execution intent.

TaskForge distinguishes requests such as:

```text
"Analyze the scheduler. Do not modify anything."
```

from:

```text
"Fix the scheduler, but do not modify the database schema."
```

The first is read-only. The second is implementation with a scoped constraint.

#### Read-only overview invariant

Simple repository-overview questions such as `What is this project?`, `O que é esse projeto?`, `How does this repository work?`, or `Resuma esse projeto` are protected by a deterministic production invariant:

```text
READ_ONLY_ANALYSIS
→ exactly 1 investigation/report task
→ exactly 1 healthy read-capable agent
→ no collaboration/reviewer fan-out
→ no repository mutation
→ no build/lint/test pass unless explicitly requested as verification
→ no delivery branch / apply / PR
```

Planner and Router output are advisory for this path. If a model over-decomposes the question or proposes a multi-agent team, TaskForge collapses it back to the invariant before execution. Read-only agent prompts also require the current repository to be treated as the source of truth and require inference to be distinguished from facts observed in repository files.

### Staffing

The router recommends the minimum useful team for a task:

- single-agent implementation;
- parallel investigation;
- implementer + reviewer;
- collaborative/pair execution;
- competitive candidates where appropriate.

Agent choice is deliberately separated from registry order. When the router names a healthy preferred agent, TaskForge honors that decision. When no preference exists, the selector chooses among healthy capability-compatible agents using persisted per-role assignment history (least-used first, then overall usage and recency) and an order-independent rendezvous hash for exact ties. Registering Claude before Codex or Antigravity must never become an accidental routing policy.

Routing is advisory. Deterministic code owns authoritative state.

### Isolation

Writable assignments run in isolated Git worktrees under `.taskforge/worktrees/`.

Agents do not need to compete for your primary working directory, and a run does not write verified work directly into your target branch.

### Live supervision

The REPL acts as an agent cockpit:

- `/tasks` shows current task and assignment state;
- `/stream` enters live agent output;
- `/focus <n>` switches to a specific active agent;
- `/back` leaves focus mode;
- `/cancel <n>` cancels one assignment;
- `/raw` shows persisted provider output;
- `/inspect` reviews run/task/assignment history.

While focused on an agent, normal text is routed to that live session instead of accidentally starting a new goal.

### Human-in-the-loop

TaskForge does not ask for confirmation for every normal engineering action.

It surfaces meaningful decisions when an agent reaches a permission/question/authentication boundary, using the existing Interaction Gateway.

The design goal is:

```text
reversible + isolated work     → automatic
material human decision        → ask
external delivery              → explicit
```

### Failover

Provider capacity is treated as an execution problem, not automatically as a task failure.

For recoverable investigation failures such as quota exhaustion, TaskForge can:

1. classify the provider failure;
2. preserve the failed assignment in the audit trail;
3. choose another healthy agent for the same role;
4. continue the run;
5. show the recovery in the cockpit.

### Completion and verification

A successful process is not automatically a successful engineering task.

TaskForge separates:

```text
provider process finished
          ↓
normalized outcome
          ↓
Completion Gate
          ↓
verification
          ↓
integration
```

That prevents cases such as:

```text
exit code 0
+ required action denied
+ no repository changes
+ old tests still green
≠
implementation completed
```

Verification can include project tests, linting, typechecking, and review.

### Delivery

Verified task results are integrated into a run-specific branch.

You then decide what happens next:

```text
/diff      inspect
/apply     apply to target branch
/pr        create pull request
/discard   keep branch only
```

---

## Autonomous, not uncontrolled

TaskForge is designed around one architectural rule:

> **AI interprets, proposes, negotiates, and reasons. Deterministic software controls authoritative state, process lifecycles, permissions, concurrency, Git state, verification, and repository integrity.**

This is how TaskForge tries to combine useful autonomy with predictable engineering behavior.

The user should not need to manually coordinate routine internal mechanics. Worktree isolation, assignment identity, concurrency accounting, provider lifecycle, failover, verification, and run state are control-plane responsibilities.

Human attention is reserved for decisions that actually need human judgment.

---

## Get started

### Requirements

- Node.js 22+
- Git
- pnpm
- at least one supported coding-agent CLI installed and authenticated:
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) — `claude`
  - [OpenAI Codex CLI](https://github.com/openai/codex) — `codex`
  - [Google Antigravity](https://antigravity.google/) — `agy`

### Install from source

```bash
git clone https://github.com/eder/taskforge.git
cd taskforge
pnpm install
pnpm build
npm link apps/cli
```

Now enter any Git repository and run:

```bash
tf
```

That is the primary TaskForge experience.

### Optional: AI router

An OpenAI-backed router/planner can improve task decomposition and team selection, but it is not required to start.

Recommended:

```bash
export TASKFORGE_OPENAI_API_KEY="..."
```

You can also store it in `~/.taskforge/config.yaml`.

If no valid key is available, TaskForge falls back to deterministic routing instead of refusing to run.

Check the current environment at any time:

```bash
tf doctor
```

or inside the REPL:

```text
/health
```

---

## Daily workflow

Most of the time, daily usage should look like this:

```bash
cd your-project
tf
```

Then describe the work naturally:

```text
> investigate why checkout latency doubled after the cache migration

> fix the race condition and add a regression test

> refactor the retry policy, but do not touch the public API

> review the payment changes without modifying the repository
```

You can revise a proposed plan conversationally before execution:

```text
> don't touch package.json

> split the database migration from the API change

> use an independent reviewer for the payment path
```

Useful cockpit commands:

| Command | Purpose |
| --- | --- |
| `/help` | Show the complete command reference |
| `/health` | Check Router, agents, provider quota, and local database health |
| `/plan` | Show the current proposed or active plan |
| `/runs` | List previous runs and delivery status |
| `/inspect [run-id]` | Inspect run → task → assignment history |
| `/tasks [task-id]` | Show task and assignment status |
| `/status` | Open the full TUI dashboard |
| `/agents` | Show detected agents and availability |
| `/stream [task-id]` | Enter live agent output |
| `/focus <n>` | Focus one active agent |
| `/back` | Leave Focus Mode and return to the overview |
| `/raw [n]` | Show persisted raw provider output |
| `/pending` | Show interactions waiting for human approval |
| `/approve [request-id] [scope]` | Approve a plan or pending interaction |
| `/deny [request-id]` | Deny a pending interaction |
| `/reject [feedback]` | Reject the current plan with feedback |
| `/constraint <text>` | Add a constraint to the current plan |
| `/reassign <task> [agent]` | Reassign work to another healthy agent |
| `/cancel [n]` | Cancel the active run or one active assignment |
| `/pause` | Pause execution |
| `/resume` | Resume execution |
| `/cost` | Show token usage and cost information |
| `/stats` | Show execution metrics for the current/recent run |
| `/diff [run-id]` | Inspect changes from a completed run |
| `/apply [run-id]` | Apply a completed run to its target branch |
| `/pr [run-id]` | Create a pull request for a completed run |
| `/discard [run-id]` | Discard delivery while keeping the integration branch |
| `/clean` | Clean temporary worktrees and branches |
| `/exit` | Exit the interactive session |

The interactive `/` menu and `/help` are generated from the same public command catalog. CI also checks this README against that catalog so a new public command cannot be merged without being documented.

Type `/` in the REPL to open the interactive command menu.

Multiline prompts, code blocks, and stack traces can be pasted directly; TaskForge uses bracketed-paste handling so the entire paste is treated as one user turn.

---

## Headless usage

The interactive REPL is the primary interface, but TaskForge also supports non-interactive workflows.

```bash
# Full run pipeline
tf run "Fix memory leak in websocket reconnection"

# Direct execution mode
tf exec "Add regression coverage for checkout retries" --yes --concurrency 2

# Inspect previous work
tf runs
tf inspect run-<id>
tf inspect run-<id> --json

# Delivery
tf apply run-<id>
tf pr create --base main

# Cleanup
tf clean
```

---

## Git model

Every writable assignment executes in a temporary worktree/branch.

A normal run looks like:

```text
target branch
    │
    ├─ task worktree A
    │      └─ agent result
    │
    ├─ task worktree B
    │      └─ agent result
    │
    └─ verified results
            ↓
     taskforge/run-<runId>
            ↓
       Delivery Gate
       /diff /apply /pr
```

For sequential collaborative teams, TaskForge creates a cumulative integration artifact so the final integrated result represents the complete team state rather than only one member's last delta.

By default, delivery is explicit. TaskForge prepares the work; you choose when it reaches the target branch.

For the detailed lifecycle, see [Git Branch Lifecycle & Hardening](docs/git-branch-lifecycle-and-hardening.md).

---

## Configuration

TaskForge is intended to work with useful defaults. Configuration is optional for normal use.

Configuration precedence:

1. project config: `.taskforge/config.yaml`
2. global config: `~/.taskforge/config.yaml`
3. built-in defaults

Example:

```yaml
router:
  provider: openai
  model: gpt-4o

execution:
  maxParallelTasks: 3
  defaultTimeoutMinutes: 30

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

git:
  workflow: trunk

delivery:
  mode: ask_human
```

Do not configure these just to get started. They exist for users who want to tune the control plane.

---

## Architecture at a glance

```text
┌──────────────────────────────────────────────────────────────┐
│                         TaskForge                            │
│                                                              │
│  Conversation / Operator                                    │
│            │                                                 │
│            ▼                                                 │
│  Semantic Planner → TaskGraph → Intent/Contract Guard       │
│            │                                                 │
│            ▼                                                 │
│  Router → Team / Roles / Execution Strategy                 │
│            │                                                 │
│            ▼                                                 │
│  Deterministic Scheduler                                    │
│      │             │              │                          │
│      ▼             ▼              ▼                          │
│   Claude         Codex        Antigravity                    │
│      │             │              │                          │
│      └──────── isolated Git worktrees ────────┐             │
│                                               │             │
│  AgentStreamBus / InteractionGateway / Failover             │
│                                               │             │
│                                               ▼             │
│                                  Completion + Verification   │
│                                               │             │
│                                               ▼             │
│                                      Integration Branch      │
│                                               │             │
│                                               ▼             │
│                                         Delivery Gate        │
└──────────────────────────────────────────────────────────────┘
```

The monorepo separates the control plane into focused packages:

```text
apps/cli          CLI entrypoint
packages/core     domain model and TaskGraph
packages/planner  goal decomposition and intent guards
packages/router   strategy, staffing, and agent selection
packages/agents   harness adapters, activity, quota tracking
packages/scheduler deterministic orchestration and team execution
packages/execution process lifecycle and Interaction Gateway
packages/conversation REPL, cockpit, streaming, HITL UI
packages/workspace Git/worktree management
packages/verification completion evidence and verification
packages/integration run-branch integration
packages/collaboration agent messaging and coordination
packages/persistence SQLite state and audit trail
packages/telemetry execution/token metrics
packages/shared shared contracts, config, and stream events
```

For deeper implementation notes, see:

- [Architecture phases 0–5](docs/architecture-phases-0-5.md)
- [Architecture phases 6–13](docs/architecture-phases-6-13.md)
- [Architecture phases 14–22](docs/architecture-phases-14-22.md)
- [Interaction Gateway spec](docs/spec-v2-interaction-gateway.md)
- [Git Branch Lifecycle & Hardening](docs/git-branch-lifecycle-and-hardening.md)

---

## Design principles

TaskForge is built around a few product rules:

**Use the agents people already like.**  
Do not reinvent Claude Code, Codex, or Antigravity. Coordinate them.

**Minimum sufficient team.**  
More agents are not automatically better. Use the smallest team that makes the task safer or faster.

**Isolation over permission fatigue.**  
Routine, reversible work should happen automatically inside isolated worktrees. Human interruptions should be meaningful.

**Failover over needless failure.**  
A provider quota problem should not automatically become an engineering-task failure when another healthy agent can satisfy the same role.

**Evidence over claims.**  
"Done" is not enough. Completion and verification use repository state, provider outcome, artifacts, tests, and other evidence.

**Delivery remains visible.**  
TaskForge may automate internal execution, but users can inspect the result before it reaches their target branch.

---

## Current status

TaskForge is actively evolving and is already being dogfooded on its own codebase.

The current focus is making multi-agent engineering feel less like operating infrastructure and more like working with a team:

- low-friction setup;
- strong defaults;
- live agent visibility;
- automatic recovery where possible;
- human attention only where useful;
- deterministic repository and delivery control.

The CI suite runs on Node 22 and Node 24.

---

## Contributing

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The repository is a TypeScript monorepo managed with pnpm workspaces.

When contributing, prefer changes that preserve the central invariant:

> AI reasons about the work; deterministic software owns authoritative state.

---

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Eder Eduardo and TaskForge contributors.
