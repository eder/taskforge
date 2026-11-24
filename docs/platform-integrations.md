# Platform Integrations: Web Cockpit, MCP Server, Daemon, SDK & Local Models

TaskForge is local-first and terminal-native, but it also integrates cleanly with browsers, external IDEs, background schedules, TypeScript scripts, local Ollama models, desktop notifications, and multi-repository workspaces.

---

## 1. Strictly-Local Web Cockpit (`tf ui` / `/ui`)

Launch a zero-dependency visual dashboard bound strictly to **`127.0.0.1`** (never exposed to the public network, zero cloud telemetry):

```bash
# Standalone CLI (default port 4310, auto-opens browser)
tf ui
tf ui --port 4320 --no-open
```

Or toggle it directly inside the REPL:

```text
/ui
```

### What the Cockpit displays (live via Server-Sent Events)

- **Workspace & Visual Diff Viewer:** current branch, HEAD commit, clean/dirty status, and parsed per-file unified diffs (`+additions` / `-deletions`).
- **Runs & Delivery History:** recent orchestrated runs from SQLite with status and delivery state.
- **Living Plan Tracker:** live view of `.taskforge/plan.md` waves and task progress.
- **Debate Council Browser:** browse saved transcripts from `.taskforge/councils/*.md`.
- **Project Memory Editor:** inspect and append entries to `.taskforge/memory.md`.
- **Telemetry & Specialty Metrics:** token/cost breakdowns and per-domain agent performance.
- **Schedules & Multi-Repo Overview:** active recurring automations and linked sibling repositories.

### Local HTTP endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | `GET` | Single-page local Cockpit HTML UI |
| `/api/state` | `GET` | Complete JSON snapshot (git, runs, Living Plan, memory, councils, telemetry, schedules, multi-repo) |
| `/api/diff` | `GET` | Parsed unified diff files against `HEAD` |
| `/api/events` | `GET` | Server-Sent Events (`text/event-stream`) live push updates |
| `/api/action` | `POST` | Trigger local actions such as `memory_add` or `undo` |

---

## 2. Model Context Protocol Server (`tf mcp serve`)

Expose TaskForge's multi-agent Debate Council, Living Plan, Project Memory, Direct Pipelines, and Checkpoints to any MCP-compatible IDE or desktop client over **stdio JSON-RPC 2.0**:

```bash
tf mcp serve
```

### Exposed MCP Tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `taskforge_status` | `{}` | Inspect repository health, agents, runs, and Living Plan progress |
| `taskforge_memory` | `{ action: "list" \| "add", text?: string }` | Read or append entries in `.taskforge/memory.md` |
| `taskforge_blueprint` | `{ goal?: string }` | Inspect or create a `.taskforge/plan.md` Living Plan |
| `taskforge_council` | `{ problem: string }` | Convene a 3-round Multi-Agent Solution Debate Council |
| `taskforge_run_direct` | `{ prompt: string }` | Execute any direct prompt or pipeline (e.g. `"@codex -> @agy ..."`) |
| `taskforge_checkpoints` | `{ action: "list" \| "undo" }` | List or undo automatic Direct Mode working-tree checkpoints |

### Exposed MCP Resources

| Resource URI | Format | Purpose |
| --- | --- | --- |
| `taskforge://plan` | `application/json` | Active `.taskforge/plan.md` blueprint and wave statuses |
| `taskforge://memory` | `application/json` | Durable project memory entries from `.taskforge/memory.md` |

### IDE / Client Configuration Examples

#### Cursor (`.cursor/mcp.json`) or VS Code (`.vscode/mcp.json`)

```json
{
  "mcpServers": {
    "taskforge": {
      "command": "tf",
      "args": ["mcp", "serve"],
      "cwd": "/path/to/your-project"
    }
  }
}
```

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "taskforge": {
      "command": "tf",
      "args": ["mcp", "serve"]
    }
  }
}
```

> Make sure `tf` is on your `PATH` (or provide the absolute path to the `tf` binary) and set the working directory to the target Git repository.

---

## 3. Local Daemon & Recurring Automations (`tf daemon`, `tf schedule`, `/schedule`)

Schedule recurring multi-agent audits, flaky-test hunts, dependency checks, or nightly codebase reviews stored in `.taskforge/schedules.json`.

### Supported schedule intervals

- Named shortcuts: `hourly`, `daily`, `nightly`, `weekly`
- Explicit durations: `30m`, `6h`, `1d`, `every 15m`, `every 2h`, `every 1d` (seconds clamped to minimum `10s`)

### CLI usage

```bash
# Manage schedules
tf schedule list
tf schedule add 6h "@codex audit recent commits for security regressions"
tf schedule add daily "/fix-ci"
tf schedule remove sch-1a2b3c
tf schedule run-now

# Run the local persistent daemon (polls due jobs, optionally serves the Web Cockpit)
tf daemon start
tf daemon start --ui-port 4310
tf daemon status
tf daemon stop
```

### REPL usage

```text
/schedule
/schedule add 6h @codex check for flaky tests and summarize causes
/schedule remove sch-1a2b3c
/schedule run sch-1a2b3c
```

Daemon PID and runtime metadata are tracked locally in `.taskforge/daemon.json`.

---

## 4. Programmatic TypeScript SDK (`TaskForgeClient`)

Embed TaskForge directly inside internal developer tools, scripts, or CI workflows using `TaskForgeClient` (exported from `@taskforge/conversation` and `@taskforge/cli`):

```ts
import { TaskForgeClient } from '@taskforge/cli';

const tf = new TaskForgeClient({
  repoRoot: process.cwd(),
  smartDirectDispatch: true,
});

try {
  // 1. Persist a cross-agent convention
  tf.remember('All database queries must use parameterized bindings', 'decision');
  const memories = tf.getMemory();
  console.log(`Loaded ${memories.length} project memory entries`);

  // 2. Run a direct multi-agent pipeline
  const pipelineOutput = await tf.run(
    '@codex -> @claude add input validation to src/routes/orders.ts',
  );
  console.log(pipelineOutput);

  // 3. Convene a 3-round Debate Council
  const councilReport = await tf.council(
    'Choose between SSE and WebSockets for live dashboard updates',
    ['claude', 'codex'],
  );
  console.log(councilReport);

  // 4. Generate or inspect a Living Plan
  const { plan } = await tf.blueprint('Add webhook retry queue with exponential backoff');
  console.log(`Plan waves: ${plan?.waves.length ?? 0}`);

  // 5. Optional: launch the local Web Cockpit programmatically
  const ui = await tf.startLocalUi(4310);
  console.log(`Cockpit running at ${ui.url}`);
  await ui.stop();

  // 6. Roll back the latest direct edit if needed
  // await tf.undo();
} finally {
  tf.close();
}
```

---

## 5. Local Open-Weight Models via Ollama (`@ollama`)

Run completely air-gapped, zero-API-cost local models alongside your cloud coding agents via [Ollama](https://ollama.com/).

### Setup

1. Install Ollama and pull a coding model:
   ```bash
   ollama pull qwen2.5-coder:latest
   ```
2. Optional environment variables:
   - `OLLAMA_HOST` — defaults to `http://127.0.0.1:11434`
   - `TASKFORGE_OLLAMA_MODEL` — defaults to `qwen2.5-coder:latest` (if not installed, TaskForge auto-selects the first locally installed model reported by `/api/tags`)
3. Optional `.taskforge/config.yaml` entry:
   ```yaml
   agents:
     ollama:
       enabled: true
       model: qwen2.5-coder:14b
   ```

### Usage

```text
@ollama explain the retry state machine in #packages/orchestrator/src/orchestrator.ts
@ollama -> @codex draft edge-case test ideas, then implement them in Vitest
/council @claude @codex @ollama compare SQLite vs DuckDB for local analytics
/model ollama deepseek-coder-v2
```

> **Note:** `OllamaAdapter` is currently read-only (`canRead: true`, `canWrite: false`), making it ideal for fast local explanations, architecture debates, code reviews, and first-stage pipeline analysis that hands off code edits to `@codex`, `@claude`, or `@agy`.

---

## 6. Deterministic Lifecycle Hooks & Native Desktop Notifications

Run deterministic shell commands automatically on key lifecycle events and receive native macOS (`osascript`) or Linux (`notify-send`) alerts when long-running tasks finish or need human approval.

Configure in `.taskforge/config.yaml` or `~/.taskforge/config.yaml`:

```yaml
hooks:
  afterDirectEdit: "pnpm prettier --write $(git diff --name-only)"
  onRunComplete: "echo \"TaskForge run finished: $TASKFORGE_HOOK_EVENT\""
  onAttentionRequired: "echo \"Human input needed\""
  timeoutSeconds: 30

notifications:
  enabled: true
  sound: true   # macOS system alert sound ("Glass")
```

Every hook receives `TASKFORGE_HOOK_EVENT` (`afterDirectEdit`, `onRunComplete`, or `onAttentionRequired`) in its environment and is bounded by `hooks.timeoutSeconds` (max `120s`).

---

## 7. Multi-Repository Coordination (`/multirepo`)

Coordinate changes across linked sibling repositories (for example `api/`, `web/`, and `sdk/`) using `.taskforge/workspace.json`:

```text
# Link sibling repositories relative to the current repo root
/multirepo init ../acme-web ../acme-sdk

# Inspect unified git branch, HEAD commit, and dirty file counts across all repos
/multirepo status

# Create/checkout a synchronized feature branch across every linked repo
/multirepo branch feat/shared-auth-v2
```

Linked repository metadata is also surfaced in the [Local Web Cockpit](#1-strictly-local-web-cockpit-tf-ui--ui) and injected as cross-repo context when planning coordinated changes.
