# TaskForge Architecture & Bootstrap Implementation (Phases 0–5)

## 1. Overview and Core Invariant

TaskForge is an independent developer-tool conversational control plane for self-organizing coding-agent teams.
This document describes the foundation and deterministic orchestration engine implemented in **Phases 0 through 5**.

> **Architectural Invariant**: AI interprets, proposes, negotiates and reasons; deterministic software controls authoritative state, Git, permissions, process lifecycle, verification and integration.

---

## 2. Implemented Components by Phase

```
                               HUMAN / CI
                                   │
                                   ▼
                             CLI (tf / taskforge)
                            [doctor, exec, inspect, cleanup]
                                   │
                                   ▼
                        Deterministic Scheduler
                                   │
                 ┌─────────────────┼─────────────────┐
                 ▼                 ▼                 ▼
             TaskGraph      ConcurrencyMgr     AgentRegistry
           [DAG, cycles]     [limits/slots]   [Fake, Claude,
                 │                 │           Codex, Gemini]
                 ▼                 ▼                 │
        Isolated Worktrees ◄─ ProcessRunner ◄────────┘
     [.taskforge/worktrees]   [timeouts, env]
                 │
                 ▼
        VerificationRunner
       [test, lint, types]
                 │
                 ▼
         IntegrationService
     [taskforge/run-<run-id>]
                 │
                 ▼
          SQLite Persistence
     [runs, tasks, events, audit]
```

### Phase 0: Foundation
- **Monorepo & Tooling**: pnpm workspace, Node.js 22+, strict TypeScript (`tsc -b`), ESLint (flat config), Vitest, Prettier, GitHub Actions CI workflow (`.github/workflows/ci.yml`).
- **Configuration**: Zod-validated configuration schema matching `.taskforge/config.yaml` specification with safe defaults.
- **Persistence Schema**: SQLite with WAL mode, foreign keys enabled, complete schema covering runs, goals, tasks, task_dependencies, task_contracts, assignments, executions, verification_results, workspaces, and audit events.
- **Audit Reconstruction**: `AuditService` reconstructs goals, tasks, timeline events, and execution records by `runId`.

### Phase 1: Process & Agent Runtime
- **ProcessRunner**: Subprocess management with PID tracking, AbortSignal cancellation, timeout enforcement, process-group termination (`SIGTERM` -> `SIGKILL`), and stdout/stderr capture to streams and log files.
- **Environment Sanitization**: Strict allowlist filtering (`PATH`, `HOME`, etc.) and pattern-based denial (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*API_KEY*`).
- **AgentAdapter Interface**: Typed interface with `detect()`, `capabilities()`, `execute()`, `send()`, and `cancel()`.
- **Harness Adapters**: Real CLI adapters for Claude Code (`claude`), Codex (`codex`), and Gemini CLI (`gemini`).
- **FakeAgent**: Deterministic test agent capable of scripted file writes, git commits, simulated delays, failures, and review findings.
- **AgentDetector & Registry**: Automatic discovery and status reporting (`tf doctor`).

### Phase 2: Git Workspace Isolation
- **GitService**: Safe native Git operations (status, rev-parse, branches, staging, commits, cherry-picks). Invariant: never silently cleans or resets user working tree.
- **WorktreeManager**: Dynamically provisions isolated Git worktrees under `.taskforge/worktrees/<taskId>/<assignmentId>`. Asserts that parallel writable work never shares a workspace. Preserves failed worktrees when requested.
- **RepositoryAnalyzer**: Inspects languages (TypeScript, JavaScript, Python, Rust, Go), package managers, frameworks, and checks for ECC (`.ecc/`).

### Phase 3: Core Task & DAG State
- **Goal & Task Models**: Strongly typed domain models including `TaskContract` (objective, allowedScope, forbiddenChanges, acceptanceCriteria).
- **TaskStateMachine**: Deterministic state machine governing lifecycle:
  `proposed` -> `preflight` -> `negotiating` -> `accepted` -> `ready` -> `assigned` -> `running` -> `completed` -> `verification` -> `verified` -> `integrated` (with rework and failure transitions).
- **TaskGraph**: Directed Acyclic Graph (DAG) with cycle detection, topological sort, and `getRunnableTasks()` (enforcing that dependencies must be verified before a task becomes runnable).
- **Extensible Interfaces**: Prepared clean interfaces for future components (`Planner`, `Router`, `Negotiator`).

### Phase 4: Deterministic Scheduler
- **ConcurrencyManager**: Manages slots against `execution.maxParallelTasks` and per-agent `maxParallel` limits.
- **DeterministicScheduler**: Main execution loop that schedules runnable tasks, provisions isolated worktrees, invokes agent adapters, drives verification, triggers rework loops, and integrates verified commits.

### Phase 5: Verification & Integration
- **VerificationRunner**: Executes test, lint, typecheck, and build commands in assignment worktrees. Captures exit codes, stdout, and duration.
- **IntegrationService**: Creates dedicated integration branch `taskforge/run-<run-id>`. Safely cherry-picks verified commits using a synchronization queue lock to prevent Git index conflicts. Detects merge conflicts and aborts without repository corruption.
- **CLI Commands**:
  - `tf doctor`: Environment diagnostics (Node, Git, SQLite, Repo Profile, Agent Harnesses).
  - `tf exec [goal]`: Headless execution of goals with concurrency options.
  - `tf inspect <run-id>`: Audit trail and timeline of tasks and events.
  - `tf cleanup`: Safe removal of transient worktrees.

---

## 3. Verified Acceptance Evidence

All automated test suites pass with 100% success (`pnpm test`, `pnpm lint`, `pnpm typecheck`):

1. **Two Concurrent FakeAgents**:
   - `agent-backend` and `agent-frontend` executed concurrently in isolated worktrees (`TASK-A` and `TASK-B`).
   - Neither interfered with the other's workspace.
2. **Dependent Task Waiting**:
   - `TASK-C` declared dependencies on `TASK-A` and `TASK-B`.
   - The scheduler held `TASK-C` until both `TASK-A` and `TASK-B` were verified, then scheduled and integrated `TASK-C`.
3. **Verification Blocking Bad Tasks**:
   - A failing task (`TASK-BAD`) was run through `VerificationRunner`.
   - Failed checks blocked the task from integration, moved it to `failed` / `blocked`, and left the integration branch clean.
4. **Audit Reconstruction**:
   - Full event stream (`TASK_STARTED`, `ASSIGNMENT_CREATED`, `TASK_COMPLETED`, `VERIFY_STARTED`, `VERIFY_COMPLETED`, `INTEGRATION_COMPLETED`) recorded in SQLite and queryable via `AuditService` and `tf inspect`.

---

## 4. Known Limitations & Out of Scope for Bootstrap

As per specification section 33.1, the following are deliberately deferred to subsequent milestones:
- **Interactive TUI / Terminal Shell**: The current interface is command-line based (`tf exec`, `tf doctor`, `tf inspect`). The interactive conversational loop starts in Phase 6.
- **Operator Agent & Natural Language Intent Mapping**: Reserved for Phase 7.
- **LLM Planner**: Initial task graphs in headless mode are defined deterministically; LLM-based graph generation is reserved for Phase 8.
- **Preflight Negotiation Protocol**: Agent preflight challenge/negotiation is reserved for Phase 9.
- **OpenAI Router & Dynamic Team Sizing**: Reserved for Phase 10.
- **Agent-to-Agent Message Bus**: Inter-agent communication bus is reserved for Phase 12.
- **ECC Plugin Integration**: Reserved for Phase 16.
