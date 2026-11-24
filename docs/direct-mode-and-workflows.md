# Direct Mode, Pipelines & Multi-Agent Workflows

TaskForge supports two complementary modes inside the same interactive REPL (`tf`):

1. **Direct Mode & Smart Auto-Dispatch** — fast, low-ceremony interaction with one or more coding agents (`@claude`, `@codex`, `@agy`, `@ollama`) with real-time streaming, automatic rollback checkpoints, `#file` / `#image` context, durable project memory, and multi-agent pipelines.
2. **Orchestrated Parallel Execution** — full plan proposal, isolated Git worktrees, verification gates, bounded recovery, and explicit delivery (`/diff`, `/apply`, `/pr`).

In default **`auto`** mode, TaskForge automatically routes quick questions, inspections, single-agent edits, and explicit `@agent` pipelines through Direct Mode, and escalates complex multi-file engineering work to full orchestration or a [Living Plan](living-plan-and-waves.md).

---

## 1. Smart Auto-Dispatch & Direct Agent Addressing

The prompt badge always shows your active target (for example `auto ▸` or `@codex ▸`).

### Addressing agents inline

```text
@claude explain the authentication middleware and session expiry flow
@codex fix the off-by-one bug in #src/pagination.ts
@agy review the CSS layout in #apps/web/src/styles.css
@ollama summarize the SQLite schema in #packages/persistence/src/database.ts
@all compare how we should structure retry backoff for webhook delivery
@smart pick the best agent for fixing the TypeScript generics in #src/router.ts
```

- **Sticky mode:** Switch your default target for multiple consecutive turns with `/use`:
  ```text
  /use codex    # all prompts go directly to Codex until changed
  /use claude
  /use agy
  /use ollama
  /use all      # broadcast to all ready agents side by side
  /use auto     # return to Smart Auto-Dispatch (default)
  ```
- **Persistent sessions:** Direct Mode conversation turns are persisted in TaskForge's local SQLite database, so restarting `tf` keeps your recent context. Use `/clear` to start a clean session.
- **Live activity & streaming:** Agents stream text tokens live into the terminal alongside a real-time activity indicator showing tool calls, files touched, and elapsed time.

---

## 2. Multi-Agent Direct Pipelines

Compose two or more agents directly from the prompt without writing YAML or boilerplate.

### Sequential handoff (`@a -> @b`)

Agent A executes the task first; Agent B receives Agent A's output and working-tree diff for an independent review, test pass, or follow-up refinement.

```text
@codex -> @claude implement idempotency keys on POST /orders and review edge cases
@ollama -> @codex draft the migration plan, then implement the TypeScript changes
```

### Two-round structured debate (`@a <-> @b`)

Two agents analyze the problem, exchange critiques, and converge on a recommendation.

```text
@claude <-> @codex should we store session state in Redis or Postgres for this workload?
```

### Parallel competitive edits (`@a @b --edit`) & Hybrid Mix

Run two or more agents concurrently in isolated temporary worktrees on the exact same prompt, inspect their diffs side by side, and either pick one winner or **cherry-pick the best files from each agent**:

```text
@claude @codex --edit refactor the CSV parser for streaming memory efficiency
```

After comparing the candidates, you can:
- accept one candidate completely, or
- **cherry-pick files across candidates** using `mix`:
  ```text
  mix src/parser.ts:#1 tests/parser.test.ts:#2
  ```
  TaskForge applies `src/parser.ts` from candidate `#1` and `tests/parser.test.ts` from candidate `#2` cleanly into your working tree (creating a rollback checkpoint first).

### Adversarial Multi-Agent TDD (`/tdd`)

Enforce strict Red → Green test-driven development across two separate agents:

```text
/tdd add rate limiting (100 req/min per API key) to the gateway middleware
/tdd @claude -> @codex enforce unique email validation on user registration
```

1. **Red phase:** Agent A (the tester) writes failing tests that specify the required behavior and verifies that the tests fail.
2. **Green phase:** Agent B (the implementer) implements the production code until the test suite passes.

---

## 3. Multi-Agent Solution Debate Council (`/council`)

For high-stakes architectural decisions, migrations, or complex tradeoffs, convene a structured **3-round Debate Council** (alias `/debate`):

```text
/council how should we migrate our single-tenant Postgres DB to multi-tenant isolation?
/council @claude @codex @agy design the offline sync protocol for our mobile client
```

### How the Council runs

1. **Round 1 — Independent Proposals:** Every participating agent proposes a complete solution independently (without anchoring on other agents).
2. **Round 2 — Dedicated Per-Solution Cross-Critiques:** Each agent critiques every other agent's proposal specifically, surfacing hidden failure modes, operational risks, and tradeoffs.
3. **Round 3 — Proponent Refinements & Synthesis:** Each proponent responds to critiques, refines its design, and TaskForge produces a structured decision matrix.
4. **Interactive Follow-Up (Round 4+):** Ask follow-up questions (`aprofundar <question>` / `ask <question>`) to drill into any risk, benchmark, or migration detail before deciding.
5. **Durable Transcript & 1-Enter Handoff:**
   - Every council transcript is saved under `.taskforge/councils/<timestamp>-<slug>.md`.
   - From the final prompt, press **Enter** (or pick an option) to hand the winning solution directly into implementation or into a phased [Living Plan (`/blueprint`)](living-plan-and-waves.md).

---

## 4. Context Attachments (`#file` and `#image`)

### `#file` interactive autocomplete

Type `#` anywhere in the REPL prompt to fuzzy-search tracked repository files and inject them as structured context:

```text
@codex explain how #packages/scheduler/src/scheduler.ts handles retries
```

### `#image` multimodal attachments

Attach local screenshots, UI mockups, or architecture diagrams via `#path/to/image.png` or an absolute file path (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`):

```text
@claude fix the button alignment shown in #screenshots/checkout-bug.png
@agy implement the pricing card layout from /Users/you/Desktop/pricing.png
```

TaskForge detects the image path, validates that the file exists, and passes it cleanly to multimodal-capable agent harnesses.

---

## 5. Automatic Checkpoints & Instant `/undo`

Before any Direct Mode agent modifies your working tree, TaskForge automatically snapshots your repository state (`DirectCheckpointManager`).

- List available checkpoints:
  ```text
  /checkpoints
  ```
- Instantly roll back the most recent Direct Mode edit (or revert the last applied orchestrated run):
  ```text
  /undo
  ```

---

## 6. Per-Agent Model & Reasoning Effort (`/model`)

Inspect or override the model and reasoning effort for any agent without hand-editing YAML:

```text
/model                                # inspect current model & effort per agent
/model codex o3 high                  # set Codex model + reasoning effort
/model claude claude-sonnet-4-6 max   # set Claude model + effort
/model agy gemini-2.5-pro             # set Antigravity model
/model ollama qwen2.5-coder:14b       # set local Ollama model
/model codex effort medium            # update effort only
/model codex reset                    # clear overrides
```

Supported reasoning effort levels: `low`, `medium`, `high`, `xhigh`, `max`.
Changes are persisted safely to `.taskforge/config.yaml` (preserving existing comments) and take effect immediately.

---

## 7. Durable Cross-Agent Project Memory (`/memory`) & `/compact`

### Project Memory (`.taskforge/memory.md`)

Maintain a shared, version-controllable set of project conventions, architectural decisions, and preferences injected automatically across **all** agents (Claude, Codex, Antigravity, Ollama):

```text
/memory                                           # list saved memories
/memory add Always use pnpm, never npm or yarn    # add an explicit entry
/memory remove 2                                  # remove entry #2
/memory clear                                     # clear all entries
```

In `auto` mode, you can also capture facts naturally in English or Portuguese:

```text
remember that all API timestamps must be UTC ISO-8601
lembra que nossos testes de integração usam Vitest e não Jest
```

### Conversation Compaction (`/compact`)

Long Direct Mode sessions automatically compact older turns into a dense rolling summary to keep prompts fast and affordable. You can also trigger compaction manually at any time:

```text
/compact
```

---

## 8. Reusable Project Skills (`/skills`, `/skill`)

TaskForge automatically discovers Markdown skill/command templates across three standard locations so you can reuse existing prompts across **every** agent:

- `.taskforge/skills/`
- `.claude/commands/`
- `.agents/skills/`

```text
/skills                                    # list all discovered skills and sources
/skill security-audit @codex src/auth/     # run a skill with a specific agent
/skill release-notes @all                  # run across all ready agents
/security-audit src/auth/                  # shorthand invocation by skill name
```

---

## 9. Shell Escapes (`!cmd`), Background Jobs (`&`) & Local Voice (`/voice`)

### Quick local shell commands

Run any command directly without leaving `tf`:

```text
!git status -sb
!pnpm test
```

### Asynchronous background jobs (`&` and `/bg`)

Prefix a long-running command with `&` to execute it in the background while you keep working in the REPL:

```text
& pnpm build && pnpm test
/bg               # list active and finished background jobs
/bg <job-id>      # inspect full output of a specific job
```

### Local-first voice input (`/voice`)

Dictate prompts hands-free with **zero cloud audio upload**:

```text
/voice            # record default clip (8 seconds) and transcribe locally
/voice 15         # record for 15 seconds (clamped between 2 and 45 seconds)
```

Supported backends (checked in order):
1. Custom command via `TASKFORGE_VOICE_CMD` (any shell command that prints the transcribed text to `stdout`).
2. Local `sox` (`rec`) + `whisper-cli` or `whisper` (for example on macOS: `brew install sox whisper-cpp`).

---

## 10. Conversational Git/PR & GitHub Autopilot

### Conversational Git actions in Direct Mode

Ask naturally in English or Portuguese to commit, check diffs, push, or open a PR from Direct Mode—TaskForge inspects `git status` / `git diff` and executes deterministic `git` / `gh` commands with confirmation where required.

### GitHub Autopilot slash commands

Requires the GitHub CLI (`gh`) to be installed and authenticated (`gh auth status`):

- **`/fix-ci`** — fetches failing GitHub Actions workflow logs for the current branch, extracts the failure context, and dispatches a targeted fix.
- **`/review-pr [#number]`** — fetches the PR diff and metadata, runs an independent multi-agent review, and offers 1-Enter posting of the review comment to GitHub.
- **`/issue <#number>`** — fetches a GitHub Issue and lets you send it straight into Orchestrated Planning, a [Living Plan (`/blueprint`)](living-plan-and-waves.md), or a Debate Council (`/council`).

---

## 11. Unified Telemetry & Specialty-Aware Routing

Both Direct Mode runs and Orchestrated runs record token usage, latency, estimated cost, and success outcomes into the same local SQLite database:

- `/cost` — token usage and approximate cost breakdown across orchestrated and direct turns.
- `/stats` — efficiency metrics and per-domain agent performance.
- **Specialty-Aware Routing:** Over time, TaskForge tracks which agent performs best per engineering domain (for example backend, frontend, tests, docs, refactoring) and uses those historical metrics to guide `@smart` and `auto` routing.
