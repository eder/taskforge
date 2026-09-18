# TaskForge — Complete Product & Engineering Specification + Roadmap

**Working name:** TaskForge  
**Repository / directory:** `taskforge`  
**Primary CLI:** `tf`  
**Long alias:** `taskforge`  
**Version:** 1.1  
**Date:** September 2026

> A conversational control plane for self-organizing coding-agent teams.

## Executive Summary

TaskForge coordinates existing coding-agent harnesses instead of replacing them. The primary experience is an interactive terminal session: run `tf`, describe an engineering objective in natural language, and keep talking to the system while it plans, staffs, executes, verifies and integrates work.

Initial workers: **Claude Code, Codex and Gemini CLI**. A task can be handled by one worker or a temporary team. Workers can challenge tasks, request context, ask peers for help, propose splitting/merging work, and escalate collaboration during execution.

A dedicated **Router Agent** uses the OpenAI Responses API with strict structured output to decide the **minimum sufficient team** and requested roles for a task. The Router is advisory. Deterministic TaskForge code owns state, availability, process lifecycle, Git, permissions, verification and integration.

ECC is an optional plugin for task-relevant skills, rules, memory, security scans and quality gates. Core TaskForge must work without ECC.

**Invariant: AI interprets, proposes, negotiates and reasons; deterministic software controls authoritative state.**

---

## Product Experience

```text
$ tf

 TaskForge
 ~/code/payments-api • main • clean
 Claude ● ready   Codex ● ready   Gemini ● ready
 Router/OpenAI ● ready
 ECC ● detected

> às vezes o checkout cobra duas vezes. investiga antes de mexer no código

Entendi. É uma tarefa com alta incerteza e risco.
Vou formar um time de investigação primeiro.

Claude  ● consistency analysis
Codex   ● reproduce + failing test
Gemini  ● payment/idempotency flow trace

Nenhuma escrita será permitida nesta fase.
```

Natural language is the primary interface. Slash commands are deterministic shortcuts such as `/agents`, `/tasks`, `/cost`, `/pause`, `/resume`, `/logs`.

Headless automation exists as a secondary surface:

```bash
tf exec "implement OAuth" --yes
tf inspect <run-id> --json
```

---

## Architecture

```text
                              HUMAN
                                │
                                ▼
                         Interactive CLI (tf)
                                │
                                ▼
                       Conversation Runtime
                                │
                                ▼
                          Operator Agent
                                │
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
              Planner       Run Queries      Commands
                 │                              │
                 ▼                              │
           Proposed TaskGraph                   │
                 │                              │
                 ▼                              │
        Task Negotiation / Preflight             │
                 │                              │
                 ▼                              │
            OpenAI Router                       │
        "team shape + roles"                    │
                 │                              │
                 ▼                              │
           Agent Selector                       │
                 │                              │
                 └──────────────┬───────────────┘
                                ▼
                    Deterministic Scheduler
                                │
                         Execution Runtime
                                │
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
              Claude          Codex          Gemini
                 ↕              ↕              ↕
                    Communication Bus
                                │
                       runtime interactions
                                ▼
                       Interaction Gateway
             ┌──────────┬──────────┬──────────┐
             ▼          ▼          ▼          ▼
          Policy     Context    Peer Agent   Human
             └──────────┴──────────┴──────────┘
                                │
                         respond / resume
                                ▼
                         Agent Sessions
                                │
                     isolated Git worktrees
                                │
                                ▼
               Verification → Review → Integration
```

### Operator Agent

The Operator converts user language into typed intents and summarizes state. It cannot directly mutate authoritative state.

### Planner

The Planner proposes a TaskGraph. The proposal is not trusted blindly. Assigned workers validate the work in preflight.

### Task Contract and Preflight

Every important task gets a contract: objective, allowed scope, forbidden scope, acceptance criteria and dependencies. A worker can return:

```ts
type TaskPreflightDecision =
  | "accept"
  | "challenge"
  | "need_context"
  | "need_dependency"
  | "recommend_collaboration"
  | "recommend_split"
  | "recommend_merge";
```

Lifecycle:

```text
proposed → preflight → negotiating → accepted → ready → running
```

### Router Agent

The Router answers only: **what execution strategy and roles does this task require?**

It considers complexity, uncertainty, risk, change surface, dependencies, validation needs, available capabilities, historical performance, availability and cost. It must choose the **minimum sufficient team**.

```ts
type CollaborationMode =
  | "single"
  | "pair"
  | "parallel"
  | "partitioned"
  | "competitive"
  | "review"
  | "collaborative"
  | "swarm";
```

Use OpenAI Responses API strict JSON-schema output. Example current configuration:

```yaml
router:
  provider: openai
  model: gpt-5.6-luna
  escalationModel: gpt-5.6-terra
  fallback: static
```

Model IDs are configuration, not architecture. If OpenAI is unavailable, use deterministic static routing.

### Roles and Agent Selection

The Router should request roles/capabilities rather than only specific brands. Agent Selector then chooses an available worker.

```text
Router: need reproduction engineer + architecture reviewer
Agent Selector:
  reproduction engineer → Codex
  architecture reviewer → Claude
```

### Collaboration and Agent Communication

One Task can contain multiple AgentAssignments and an internal AssignmentGraph. Agents communicate through a bounded message bus using types such as question, answer, challenge, evidence, proposal, review, handoff, blocker and context_request.

```yaml
collaboration:
  maxAgentsPerTask: 3
  maxMessagesPerRound: 6
  maxRounds: 3
  requireReasonForEscalation: true
```

Workers can request collaboration during execution. Router reevaluates staffing; Scheduler applies the decision safely.

### Agent Interaction Gateway & Human-in-the-Loop

Real coding harnesses can pause mid-run to ask a question, request permission, require confirmation, request tool approval, or require authentication. TaskForge normalizes those provider-specific interactions instead of allowing child processes to hang on unseen stdin.

```ts
interface AgentSession {
  sessionId: string;
  events(): AsyncIterable<AgentRuntimeEvent>;
  send(message: AgentMessage | AgentInput): Promise<void>;
  respond(response: InteractionResponse): Promise<void>;
  cancel(): Promise<void>;
}

type AgentRuntimeEvent =
  | AgentOutputEvent
  | AgentQuestionEvent
  | PermissionRequestEvent
  | ConfirmationRequestEvent
  | InputRequiredEvent
  | AuthenticationRequiredEvent
  | ToolApprovalEvent
  | AgentStatusEvent
  | AgentErrorEvent
  | AgentCompletedEvent;
```

Provider-specific prompt detection belongs inside each adapter. Core TaskForge only consumes normalized events.

Assignment waiting states:

```text
running
  ├─→ waiting_input ───────→ running
  ├─→ waiting_permission ──→ running
  ├─→ waiting_auth ────────→ running
  └─→ failed / completed
```

An interaction normally blocks only the affected assignment; independent ready tasks continue.

#### Permission Engine

```yaml
permissions:
  filesystem:
    workspace_write: allow
    outside_workspace: ask_human
    delete_files: ask_human
  commands:
    tests: allow
    lint: allow
    package_install: ask_human
    network: ask_human
    sudo: deny
  git:
    commit: allow
    push: ask_human
    force_push: deny
    merge_main: deny
```

Permissions resolve deterministically to `allow`, `deny`, or `ask_human`. Unknown permissions use the safer configured fallback. Native CLIs may never silently bypass TaskForge policy.

#### Question Router

```text
AUTO_RESOLVE    authoritative TaskForge context already answers it
ROUTE_TO_AGENT  another worker/reviewer can answer a technical question
ASK_HUMAN       product/requirement decision needs the user
POLICY_ALLOW    deterministic permission policy permits it
POLICY_DENY     deterministic permission policy rejects it
BLOCK           cannot safely continue
```

TaskForge must not invent product decisions just to keep an agent moving.

#### Conversational approvals

```text
Codex precisa de uma decisão.

Ele quer instalar:
@fastify/oauth2

> pode instalar só para essa task

✓ permitido para TASK-14
Codex retomou o trabalho.
```

The user can resolve several pending interactions in one natural-language message. The Operator maps each answer back to explicit interaction IDs. If an answer changes a shared requirement, TaskForge persists it as structured run state and notifies affected assignments.

Authentication is a distinct interaction. TaskForge pauses the affected assignment and requires explicit re-authentication; it never fabricates credentials or asks a peer agent for secrets.

#### Headless policy

```yaml
headless:
  onHumanQuestion: block
  onUnknownPermission: deny
  onAuthenticationRequired: fail
  onConfirmationRequired: block

interactions:
  humanResponseTimeout: 30m
  onTimeout:
    permission: deny
    question: block
    confirmation: block
```

Headless mode must never hang indefinitely. Persist `interaction_requests` and `interaction_responses` with priority, timeout, resolution source (`policy`, `context`, `agent`, `human`) and approval scope (`once`, `task`, `run`, `project`).

---

## Git and Workspace Rules

Parallel writers never share a worktree.

```text
.taskforge/worktrees/
└── TASK-12/
    ├── codex-implementer/
    ├── claude-alternative/
    └── gemini-experiment/
```

- Never silently reset/clean user changes.
- Never allow two parallel writable assignments in one worktree.
- Preserve failed work for inspection.
- Never automatically push or merge to main in early releases.

---

## Verification

Agent self-report is not completion evidence.

```text
agent work
  ↓
repository diff / expected changes
  ↓
acceptance checks
  ↓
tests / lint / typecheck / build
  ↓
required independent review
  ↓
verified
```

Critical/major review findings cause bounded rework. Repeated failure can trigger collaboration escalation.

---

## Persistence

SQLite + Git are authoritative. Initial tables:

```text
runs
goals
constraints
tasks
task_dependencies
task_contracts
assignments
executions
agent_messages
interaction_requests
interaction_responses
routing_decisions
preflight_results
reviews
verification_results
workspaces
plugins
events
metrics
```

---

## ECC Plugin

ECC is optional. It may contribute skills, rules, memory, security scanning and quality gates. TaskForge retains planning, routing, scheduling, state, worktrees, verification and integration. Load only task-relevant ECC capabilities.

---

## Security

- Worktree isolation.
- No automatic sudo.
- Environment-variable allowlisting.
- Secret filtering.
- Permission Engine for destructive or privileged operations.
- No native agent prompt may bypass TaskForge interaction policy.
- Restricted writable paths.
- No silent push.
- AI services are advisory; control-plane integrity remains local/deterministic.
- Repository text and logs are untrusted inputs.

---

## Technology

- TypeScript
- Node.js 22+
- pnpm
- Zod
- SQLite
- native Git CLI
- child_process/execa
- Vitest
- ESLint + Prettier
- GitHub Actions

Do not introduce LangChain, CrewAI, Temporal, Kafka, Redis, PostgreSQL or Kubernetes before a demonstrated requirement.

---

## Roadmap

| Phase | Milestone |
|---:|---|
| 0 | Foundation |
| 1 | Runtime event + Interaction Gateway primitives |
| 2 | Process + real agent adapters |
| 3 | Git workspace isolation |
| 4 | Core task/DAG state |
| 5 | Deterministic scheduler |
| 6 | Verification/integration |
| 7 | Interactive shell + human interaction UX |
| 8 | Operator Agent |
| 9 | Planner |
| 10 | Task Contract + Preflight / negotiation |
| 11 | OpenAI Router + static fallback |
| 12 | Agent Selector |
| 13 | Agent Communication Bus |
| 14 | Collaborative Execution / AssignmentGraph |
| 15 | Real-agent E2E v0.1 |
| 16 | Plugin SDK |
| 17 | ECC plugin |
| 18 | Telemetry |
| 19 | Performance engine |
| 20 | Adaptive routing |
| 21 | Advanced TUI/UX |
| 22 | GitHub workflow |
| 23 | Remote workers |

---

## Bootstrap Implementation Prompt

```text
IMPLEMENTATION START — TASKFORGE

Create a new repository/directory named: taskforge
Primary binary: tf
Long alias: taskforge

Implement ONLY Phases 0–6:
0 Foundation
1 Runtime event + Interaction Gateway primitives
2 Process + real agent adapters
3 Git workspace isolation
4 Core task/DAG state
5 Deterministic scheduler
6 Verification/integration

Do NOT implement yet:
- conversational Operator Agent
- OpenAI Router API
- Planner LLM
- task negotiation LLM logic
- agent-to-agent communication
- ECC plugin
- adaptive routing
- TUI
- GitHub PR automation
- remote workers

Required stack:
TypeScript, Node.js 22+, pnpm, strict TypeScript, Zod, SQLite, Vitest, ESLint, Prettier, GitHub Actions.

Required behavior:
- AgentAdapter + AgentSession contracts
- normalized AgentRuntimeEvent stream
- Interaction Gateway core
- Permission Engine with allow / deny / ask-human policy
- Question Router contracts for context / peer / human resolution
- interaction persistence and headless fallback policies
- FakeAgent that can emit permission, question, confirmation and auth-required events
- Claude Code / Codex / Gemini CLI adapters that normalize native interactions
- process runtime, timeout, cancellation
- repository analyzer + Git service + WorktreeManager
- Goal / Task / TaskGraph / state machine
- deterministic scheduler with concurrency limits
- verification runner
- run-specific integration branch
- event persistence
- tests proving isolated concurrent fake work

Before finishing:
1. run tests
2. run lint
3. run typecheck
4. demonstrate two FakeAgents concurrently in separate worktrees
5. demonstrate dependency waiting
6. demonstrate failed verification blocking integration
7. document architecture and limitations
8. demonstrate a FakeAgent waiting for permission while an unrelated task continues
9. demonstrate headless unknown permission deny/block without hanging
10. STOP and report results
```

## Final Principle

TaskForge is not “three AIs answering a prompt.” It is a conversational engineering control plane where agents can reason, negotiate, challenge work, ask peers for help and self-organize into temporary teams while deterministic software controls state, permissions, human/agent interaction routing, concurrency, Git, verification and integration.
