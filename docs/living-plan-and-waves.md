# Living Plan, Wave Execution & Parallel Worktree Coordination

When a goal spans an entire product, a greenfield repository, or a multi-module milestone, trying to cram 15 edits into a single one-shot task graph creates overlapping scopes, merge conflicts, and stale assumptions.

TaskForge's **Living Plan** (`.taskforge/plan.md`) solves this by turning large engineering initiatives into **phased execution waves** backed by deterministic parallel worktrees, isolated port allocations, and live peer-agent coordination.

---

## 1. Domain-Agnostic & Greenfield-Ready

TaskForge inspects your repository automatically (`RepositoryAnalyzer`) before planning:

- **Greenfield repositories** (`isGreenfield: true`, zero or minimal source files): TaskForge recognizes that directory structure does not exist yet. Instead of forcing premature parallel file-scope splits, **Wave 1** establishes the foundational architecture, build/test toolchain, and shared contracts with root-level scope (`**`).
- **Existing repositories** (any stack — API, full-stack web, CLI, mobile, data pipeline, library, game, infrastructure): TaskForge maps tracked directories (`git ls-files`), detects test/lint/typecheck commands, and structures waves around real module boundaries.

---

## 2. Anatomy of a Living Plan (`.taskforge/plan.md`)

A Living Plan is a human-readable, Git-trackable Markdown document stored at `.taskforge/plan.md`. You can edit it directly in your editor or refine it conversationally inside `tf`.

### Typical 3-Wave structure

| Wave | Purpose | Execution Pattern |
| --- | --- | --- |
| **Wave 1 — Foundation & Contracts** | Project scaffolding, shared types/schemas, storage/core interfaces, toolchain setup | Focused sequential/foundational run (root `**` allowed on greenfield repos) |
| **Wave 2 — Parallel Vertical Slices** | Independent features, modules, services, or UI sections with disjoint file scopes | **Deterministic parallel fan-out** across multiple isolated Git worktrees |
| **Wave 3 — Integration, E2E & Polish** | Cross-module wiring, end-to-end verification, documentation, hardening | Unified integration pass over the updated repository |

### Commands

```text
/blueprint Build a multi-tenant SaaS invoicing platform with Stripe webhooks and PDF export
/blueprint                         # inspect current .taskforge/plan.md progress & next wave
/blueprint refine Add a GraphQL API slice to Wave 2 and use Drizzle ORM in Wave 1
/blueprint next                    # compile and launch the next pending wave
/blueprint reset                   # archive/clear the active blueprint to start fresh
```

> `/waves` is an alias for `/blueprint`.

---

## 3. Seamless Wave Transitions & Deterministic Wave 2 Compiler

TaskForge removes manual ceremony between waves while keeping deterministic Git safety:

1. **Wave 1 completes** → TaskForge offers a **1-Enter auto-apply** onto your target branch before advancing.
2. **Live Repository Re-Scan** → Before launching Wave 2, TaskForge re-scans the newly created files and directories from Wave 1 so every agent sees the real codebase structure (not guesses from before Wave 1 existed).
3. **Deterministic Parallel Compilation (`compileWaveToTaskGraph`)** → Each independent item in Wave 2 is compiled deterministically into a `TaskGraph` node with explicit non-overlapping `allowedScope`, acceptance criteria, and dependencies—so healthy agents run truly in parallel in separate worktrees under `.taskforge/worktrees/`.
4. **Wave 3 Integration** → After Wave 2 slices are verified and applied, Wave 3 wires everything together and validates the complete system.

---

## 4. Per-Worktree Port Isolation (`.taskforge.env`)

When 2–4 agents run integration tests or dev servers concurrently in parallel worktrees, hardcoded ports like `localhost:3000` or `localhost:5432` normally cause flaky `EADDRINUSE` failures.

TaskForge's **`WorktreePortAllocator`** automatically reserves a verified-free block of TCP ports on `127.0.0.1` for every worktree (starting at port `4100`, stride `10`), writes a git-excluded `.taskforge.env` file into the worktree root, and releases the block when the worktree is cleaned up.

### Allocated environment variables

| Variable | Value (example for worktree 1) | Value (example for worktree 2) | Purpose |
| --- | --- | --- | --- |
| `PORT` | `4100` | `4110` | Primary HTTP / web server port |
| `TASKFORGE_PORT` | `4100` | `4110` | Explicit primary service port |
| `TASKFORGE_API_PORT` | `4101` | `4111` | Secondary backend / API port |
| `TASKFORGE_DB_PORT` | `4102` | `4112` | Local test database / cache port |
| `TASKFORGE_PORT_OFFSET` | `0` | `10` | Offset from base port `4100` |

**Tip:** In your project's test setup or dev server scripts, read `process.env.PORT` / `process.env.TASKFORGE_API_PORT` (or load `.taskforge.env` if present) to make parallel worktree test suites 100% collision-free.

---

## 5. Peer Mailbox & Deterministic File Locks

Parallel agents working in sibling worktrees can coordinate without corrupting shared files via TaskForge's file-backed **`PeerMailbox`**:

- **Mailbox log:** `.taskforge/mailbox/<runId>.jsonl`
- **Advisory file leases:** `.taskforge/mailbox/<runId>.locks.json`

### Supported peer message kinds

- `discovery` — share an important codebase finding with sibling tasks
- `contract_update` — announce an exported interface, endpoint, or schema refinement
- `warning` — flag a pitfall, flaky test, or environment quirk
- `question` — request clarification relevant to another task
- `handoff` — pass concrete context to a downstream task

Unread peer messages are formatted compactly into sibling agents' prompts (`formatInboxForPrompt`), while deterministic advisory leases (`acquireLease` / `releaseLeases`) prevent two concurrent tasks from claiming the same shared file at once.

---

## 6. Recommended End-to-End Flow for Large Features

1. **Debate the architecture (optional):**
   ```text
   /council design the event-driven billing subsystem
   ```
2. **Generate and refine the Living Plan:**
   ```text
   /blueprint implement the chosen billing architecture with Postgres + webhook workers
   /blueprint refine keep webhook signature verification in its own Wave 2 slice
   ```
3. **Execute Wave by Wave:**
   ```text
   /blueprint next    # runs Wave 1 → press Enter to apply
   /blueprint next    # re-scans repo → fans out Wave 2 slices in parallel worktrees
   /blueprint next    # runs Wave 3 integration & full verification
   ```
4. **Inspect visually or ship a PR:**
   ```text
   /ui                # inspect diffs, waves, and council records in the Local Web Cockpit
   /pr                # open a GitHub Pull Request with verification evidence
   ```
