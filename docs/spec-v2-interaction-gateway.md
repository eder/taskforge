# TaskForge Specification v2 (v1.1): Agent Interaction Gateway & Human-in-the-Loop Architecture

**Specification Reference:** `taskforge-complete-product-engineering-spec-v2.md`  
**Date:** September 2026  
**Status:** Implemented & Verified

---

## 1. Executive Summary

TaskForge Specification v2 (v1.1) elevates TaskForge by introducing a unified **Agent Interaction Gateway**, a deterministic **Permission Engine**, a semantic **Question Router**, **Conversational Approvals** with granular scopes, and full **Headless Automation** (`tf exec` and `tf inspect`).

Instead of allowing underlying agent processes (such as Anthropic Claude Code, OpenAI Codex, or Google Gemini CLI) to block silently on unhandled `stdin` or bypass security policies, TaskForge intercepts, normalizes, and deterministically governs every interaction prompt via structured event streaming.

```mermaid
flowchart TD
    Human([Human Operator / Terminal / Headless CLI]) -->|Approvals & Answers| Shell[InteractiveShell / tf exec]
    Shell --> Operator[OperatorAgent Intent Parser]
    Operator --> Gateway[InteractionGateway]

    SubGraph GatewaySub [Agent Interaction Gateway]
        Gateway --> Router[QuestionRouter]
        Gateway --> PermEngine[PermissionEngine]
        Gateway --> Repo[(SQLite interaction_requests & responses)]
    end

    Router -->|AUTO_RESOLVE| Context[Task Contract & Shared State]
    Router -->|ROUTE_TO_AGENT| PeerAgent[Peer Reviewer / Specialist]
    Router -->|POLICY_ALLOW / POLICY_DENY| PermEngine
    Router -->|ASK_HUMAN| Operator

    Scheduler[DeterministicScheduler] --> Sessions[AgentSession Stream]
    Sessions -->|Normalized Runtime Events| Gateway
    Gateway -->|Resume / Decision / Answer| Sessions
    Sessions --> Worktrees[Isolated Git Worktrees]
```

---

## 2. Architectural Invariants

1. **Non-Blocking Concurrency**: An agent interaction pausing for input, permission, or authentication (`waiting_input`, `waiting_permission`, `waiting_auth`) ONLY blocks that specific assignment. Unrelated, independent ready tasks continue parallel execution without hindrance.
2. **Deterministic Governance**: AI agents propose actions, question specifications, or request permissions; authoritative deterministic software (Node.js/TypeScript) enforces policies, commits state, and executes verification gates.
3. **No Silent CLI Bypass**: Real agent harnesses running in child processes never bypass TaskForge security or Git guardrails. All operations on filesystem, external commands, and git are evaluated against the configured permission matrix.
4. **Local-First & Zero-Bloat**: Persisted locally via SQLite WAL mode tables (`interaction_requests`, `interaction_responses`), Git worktrees, and native OS processes. Zero external heavyweight dependencies.

---

## 3. Core Components

### 3.1 Agent Sessions & Runtime Events (`@taskforge/agents` & `@taskforge/shared`)

Real coding CLI harnesses produce disparate terminal formats. The `AgentSession` interface normalizes these into a typed `AsyncIterable<AgentRuntimeEvent>` stream:

- **`AgentSession`**:
  - `sessionId: string`
  - `events(): AsyncIterable<AgentRuntimeEvent>`
  - `send(message: AgentMessage | AgentInput): Promise<void>`
  - `respond(response: InteractionResponse): Promise<void>`
  - `cancel(): Promise<void>`

- **Normalized Event Stream**:
  - `output` (stdout/stderr chunks)
  - `question` (prompt, options)
  - `permission_request` (category, operation, resource)
  - `confirmation_request` (operation, risk, prompt)
  - `input_required` (prompt, isSecret)
  - `authentication_required` (provider, authUrl, prompt)
  - `tool_approval` (toolName, toolCallId, args)
  - `status` (state change)
  - `error` (code, message)
  - `completed` (exitCode, summary)

### 3.2 Permission Engine (`@taskforge/execution`)

Deterministically evaluates requests against the hierarchical permissions policy:

- **Categories**:
  - `filesystem`: `workspace_write` (allow), `outside_workspace` (ask_human), `delete_files` (ask_human).
  - `commands`: `tests` (allow), `lint` (allow), `package_install` (ask_human), `network` (ask_human), `sudo` (deny).
  - `git`: `commit` (allow), `push` (ask_human), `force_push` (deny), `merge_main` (deny).
- **Scoped Approvals**:
  - Supports cached decisions scoped to `once`, `task`, `run`, or `project`.

### 3.3 Question Router (`@taskforge/execution`)

Routes inquiries using six deterministic outcomes:

1. `AUTO_RESOLVE`: Authoritative TaskForge task contract (allowedScope, acceptanceCriteria) or repository context already answers it.
2. `ROUTE_TO_AGENT`: Another assigned worker or specialist (e.g. architecture reviewer) can answer the technical question.
3. `ASK_HUMAN`: Product or business requirement decision strictly requires human operator input (TaskForge never invents product decisions).
4. `POLICY_ALLOW`: Permitted by deterministic security policy.
5. `POLICY_DENY`: Forbidden by deterministic security policy.
6. `BLOCK`: Cannot safely continue execution.

### 3.4 Interaction Gateway (`@taskforge/execution`)

Central coordinator managing live session event streams, pending interaction tracking, auto-resolution, configurable human timeout handling (`humanResponseTimeout`), and persistence synchronization via `InteractionRepository`.

### 3.5 Persistence Layer (`@taskforge/persistence`)

Tables added to SQLite schema (`TaskForgeDatabase.initSchema`):

- `interaction_requests`: `(id, run_id, task_id, assignment_id, agent_id, type, prompt, category, resource, status, priority, timeout_ms, scope, created_at, resolved_at)`
- `interaction_responses`: `(id, request_id, decision, payload, source, scope, responder_id, created_at)`
- Indexed on `run_id`, `task_id`, `status`, and `request_id`.

### 3.6 Conversational Approvals & Interactive Shell (`@taskforge/conversation`, `@taskforge/operator`)

Operator agent parses natural language approvals:

- Examples: `"pode instalar só para essa task"`, `"sim, aprova para o projeto"`, `"rejeita isso"`.
- Slash shortcuts: `/pending`, `/approve <id> [scope]`, `/deny <id> [reason]`.
- Granular scopes: `once`, `task`, `run`, `project`.

### 3.7 Headless Automation (`apps/cli`)

- `tf exec "<goal>" [-y, --yes] [--json] [--mode <interactive|headless>]`: Executes runs headlessly without hanging.
- `tf inspect <run-id> [--json]`: Inspects run state, tasks, assignments, telemetry, and pending interaction requests.
- Headless timeouts and policies:
  - `onHumanQuestion: block`
  - `onUnknownPermission: deny`
  - `onAuthenticationRequired: fail`
  - `onConfirmationRequired: block`

---

## 4. Verification & Validation Metrics

All Spec v2 criteria have been validated via automated test suites:

| Test / Criterion                                                                         | Suite                                | Status                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------- |
| **Deterministic Permissions** (filesystem, commands, git)                                | `tests/e2e-spec-v2.test.ts` (Test 1) | **PASSED**                       |
| **Scoped Approvals** (once, task, run, project)                                          | `tests/e2e-spec-v2.test.ts` (Test 1) | **PASSED**                       |
| **Question Router Outcomes** (AUTO_RESOLVE, ROUTE_TO_AGENT, POLICY_*, ASK_HUMAN)         | `tests/e2e-spec-v2.test.ts` (Test 2) | **PASSED**                       |
| **Persistence & Database Indexes** (SQLite requests & responses)                         | `tests/e2e-spec-v2.test.ts` (Test 3) | **PASSED**                       |
| **Spec v2 Criterion 8**: FakeAgent waiting for permission while unrelated task continues | `tests/e2e-spec-v2.test.ts` (Test 4) | **PASSED**                       |
| **Spec v2 Criterion 9**: Headless unknown permission deny/block without hanging          | `tests/e2e-spec-v2.test.ts` (Test 5) | **PASSED**                       |
| **Conversational Approvals**: Natural language "pode instalar só para essa task"         | `tests/e2e-spec-v2.test.ts` (Test 6) | **PASSED**                       |
| **Headless CLI**: `tf exec` and `tf inspect` commands with `--json`                      | `tests/e2e-spec-v2.test.ts` (Test 7) | **PASSED**                       |
| **Complete Monorepo Suite**: 20 test files, 72 total unit and e2e tests                  | `pnpm test`                          | **72/72 PASSED**                 |
| **TypeScript Typecheck**: Monorepo composite build                                       | `pnpm -r build`                      | **CLEAN (0 errors)**             |
| **ESLint Compliance**: Strict TypeScript rules                                           | `pnpm lint`                          | **CLEAN (0 errors, 0 warnings)** |

---

## 5. Limitations & Future Extensions

1. **Native TTY Emulation for Interactive CLIs**:
   - Currently, real agent adapters wrap subprocesses with non-interactive CLI arguments (`--print` for Claude Code, `-q` for Codex). If an agent tool requires full ANSI pty terminal input, integrating `node-pty` will expand support for interactive terminal escapes.
2. **Fine-grained Subpath File Write Constraints**:
   - While worktree isolation guarantees complete directory boundary enforcement, path pattern matching (`minimatch`) can be further extended in the `PermissionEngine` to restrict writes within specific submodules according to contract `allowedScope`.
3. **External Secrets Vaults**:
   - For `waiting_auth` events, tokens are handled via standard environment variables and user prompts; future enterprise plugins could integrate directly with 1Password CLI, AWS Secrets Manager, or HashiCorp Vault.
