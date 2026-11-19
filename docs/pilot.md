# Pilot checklist: validating TaskForge with real agents

Automated tests use simulated agents, so they cannot prove that TaskForge behaves well with real Claude Code, Codex CLI and Antigravity. Run this checklist once per release candidate (and after upgrading an agent CLI) on a **throwaway or low-risk repository**. It spends real provider quota.

## 0. Preparation

```bash
git clone <a small repo with a passing test suite> pilot && cd pilot
git checkout -b pilot-base
tf doctor            # every agent you plan to use must be ready
```

Keep the default permissions and `delivery.mode: ask_human`. Set `verification.commands` (or make sure tests/lint are auto-discovered) so tasks cannot be BLOCKED for missing verification.

Record each step's result in the table at the bottom.

## 1. Read-only analysis

`tf` → *"explain how the test suite is organized"*

Pass criteria: runs without an approval prompt, answer is grounded in repository files, `git status` shows **no** changes, `/inspect` shows no `MUTATION_BLOCKED` events.

## 2. Small implementation, single agent

*"add a unit test for <small existing function>"*

Pass criteria: plan shown with an **Estimated usage** line before approval; worktree created under `.taskforge/worktrees`; verification runs; `/diff` shows only the expected files; `/apply` merges cleanly; your original branch was never touched before `/apply`.

## 3. Scope enforcement

Add an ownership rule or pick a task with a narrow scope, then ask for a change that tempts the agent to edit another area (for example *"fix the typo in src/a and also tidy src/b"* with scope `src/a/**`).

Pass criteria: a `SCOPE_VIOLATION` event is recorded, the stray file is **not** integrated, and a retry that reverts it completes.

## 4. Failure handling

- **Agent dies mid-run:** start a task, then `kill` the agent process (`pgrep -f claude`). Expect the task to fail, recover (retry, then reassign), and never mark itself done.
- **Verification fails:** make a task whose acceptance requires a failing test to pass. Expect rework with the failure output as evidence, then BLOCKED after `maxReworkCycles`. Delivery must stay disabled.
- **Quota exhausted:** if an agent reports quota exhaustion, expect it to be excluded and work reassigned to a healthy agent.

## 5. Interrupt and resume

Start a multi-task plan (≥3 tasks with dependencies), press Ctrl-C after the first task is integrated, then:

```bash
tf runs
tf resume run-<id>
```

Pass criteria: the integrated task is **not** re-executed, remaining tasks run from the cumulative branch, the run completes, and `/diff` contains all tasks.

## 6. Cleanup

```bash
tf cleanup --prune --older-than 0s --dry-run   # review first
tf cleanup --prune --older-than 0s
git worktree list                              # your own worktrees must still be listed
```

## 7. Credentials (spot check)

While a Claude task runs, inspect its environment:

```bash
ps eww -p $(pgrep -f "claude" | head -1) | tr ' ' '\n' | grep -E "OPENAI|TASKFORGE|SSH_AUTH_SOCK|GITHUB_TOKEN" || echo "none forwarded (expected)"
```

Pass criteria: no `TASKFORGE_OPENAI_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN` or `SSH_AUTH_SOCK` in a Claude Code process.

## 8. Optional: dual review

Enable `verification.dualReview` with a sensitive scope and run a task in it. Pass criteria: a *different* agent reviews, a missing verdict blocks integration, and `/inspect` lists the review assignment.

## 9. Measure parallelism, time and tokens

TaskForge exists to get several agents working at once, cheaper and faster than one agent working alone. Steps 1-8 check that it is safe; this step checks that it pays off. Run it on 3 to 5 real tasks that touch more than one area of the project (for example storage + HTTP layer), and once with `execution.profile: economy` (the default). Replace `<db>` with `.taskforge/taskforge.db` (the `execution.databasePath` of the project).

```bash
# Tokens the agents used, per run (fresh vs cached vs plan estimate)
sqlite3 -header -column <db> "SELECT run_id,
  sum(input_tokens - cached_input_tokens + output_tokens) AS fresh_tokens,
  sum(cached_input_tokens) AS cached_tokens,
  sum(total_tokens) AS total_tokens,
  sum(planned_estimated_tokens) AS est_fresh,
  round(1.0 * sum(input_tokens - cached_input_tokens + output_tokens) / nullif(sum(planned_estimated_tokens), 0), 2) AS fresh_vs_est
  FROM cost_tracking GROUP BY run_id ORDER BY rowid DESC LIMIT 10;"

# Parallelism achieved: agent-seconds divided by wall-clock seconds (1.0 = no overlap)
sqlite3 <db> "SELECT run_id,
  round(sum((julianday(finished_at)-julianday(started_at))*86400),1) AS agent_s,
  round((julianday(max(finished_at))-julianday(min(started_at)))*86400,1) AS wall_s,
  round(sum((julianday(finished_at)-julianday(started_at))*86400) /
        ((julianday(max(finished_at))-julianday(min(started_at)))*86400),2) AS parallelism
  FROM executions WHERE finished_at IS NOT NULL GROUP BY run_id ORDER BY max(finished_at) DESC LIMIT 10;"

# Plans where independent tasks were forced to run in turn (their scopes may overlap)
sqlite3 <db> "SELECT run_id, payload_json FROM events WHERE type='PLAN_PARALLELISM_LIMITED';"

tf insights --since 7        # completion rate, what stopped work, tokens and cost, how each agent did, and parallel work (x times)
```

How to read it:

- `tf insights` also prints **where the time went** (agents / checks / TaskForge's own steps, and the wait before the first agent): that is the overhead TaskForge adds on top of the agents' own time.
- **parallelism** well above 1.0 on a multi-area task means agents really overlapped; around 1.0 on such a task means the plan was serialized or the task was not splittable.
- A `PLAN_PARALLELISM_LIMITED` event on a task you expected to split is the thing to look at: open `tf inspect <run>` and compare the tasks' `allowedScope` with the project's directories.
- Compare `tokens` with the plan's *Estimated usage* line. A large, repeated gap means the estimate (and the cap) cannot be trusted yet.
- To judge the benefit of parallel work, run one of the same tasks as a single-agent task and compare `wall_s` and `tokens`.

Record the numbers in the table below. They are the evidence for the parallelism and cost claims, not the test count.

## Results

Recorded on **`v1.0.0-rc.1`** (macOS, Node.js `v24.14.1`, `execution.profile: economy`, default permissions, `delivery.mode: ask_human`, agents `codex` + `agy`; throwaway multi-area Node.js repository with `src/storage/`, `src/domain/`, `src/http/`, `tests/`).

| Step | Agent(s) | Pass? | Notes / run id |
| --- | --- | --- | --- |
| 1 Read-only | `agy` | Pass | `run-1795059749444336` — `49.5s`, `23,612` fresh / `0` cached (est. `20,633`, **1.14×**), `git status` clean, `0` `MUTATION_BLOCKED` events. |
| 2 Small implementation | `codex` | Pass | `run-1795059816855542` — `37.2s`, `40,600` fresh + `175,104` cached = `215,704` total (est. `44,542` fresh, **0.91×**), base branch untouched before `tf apply`, merged cleanly (`4bdaca0`), `4/4` tests pass. |
| 3 Scope enforcement | `agy`, `codex` | Pass | `run-1795059894416568` (`agy`), `run-1795059950194008` (`codex`) — both agents respected `allowedScope: ['src/storage/**']`, refused stray edits in `src/http/router.js` / `tests/app.test.js`, integrated only `src/storage/store.js`. |
| 4 Failure handling | `codex`, `agy` | Pass | 4a (`run-1795060004291685`): `SIGKILL` mid-run on `codex` → failed (`exit 128`) → `Recovery 1/2` → completed (`37.8s`). 4b (`run-1795060059097377`, `agy`): verification failed → kept work on candidate branch → `Recovery 1/1` → `BLOCKED`, delivery disabled. Auth fail-fast also verified on signed-out `claude` (`oauth_org_not_allowed`, 1 attempt, `5.3s`). |
| 5 Interrupt + resume | `codex` | Pass | `run-1795060145940098` — cancelled after task 1 integrated (`13.3s`); `tf resume` kept task 1 (1 execution only), ran tasks 2–3 on cumulative branch (`35.3s`), all 3 files in final diff. |
| 6 Cleanup | n/a | Pass | `tf cleanup --prune --older-than 0s --dry-run` & `--prune` removed stale TaskForge worktree (`STALE-1/asgn-stale`) and preserved user worktree in `git worktree list`. |
| 7 Credentials | `codex` | Pass | Live `ps eww` on `codex exec` (PID `20413`) with `GITHUB_TOKEN` & `SSH_AUTH_SOCK` set in parent env: none of `TASKFORGE_OPENAI_API_KEY`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `ANTHROPIC_API_KEY` forwarded. |
| 8 Dual review | (optional) | — | Covered by automated gate suite (`dual-review-gate.test.ts`); not run separately in this pass. |

Measurements (step 9):

| Task | Areas touched | Tokens (fresh / cached / total; vs est.) | Wall s | Parallelism | Serialized? | Single-agent tokens / wall s |
| --- | --- | --- | --- | --- | --- | --- |
| 9.1 `findBy` + `completeTask` + `GET /health` (`run-1795060469392871`) | `src/storage`, `src/domain`, `src/http` | `70,171` fresh + `224,768` cached = `294,939` (`codex` ×2 + `agy` ×1; est. `76,396`, **0.92×**) | 53.7s (`88.8s` agent) | **1.65x** | No (`0`) | — |
| 9.2 `keys()` + `formatTaskSummary` (`run-1795060556786211`) | `src/storage`, `src/domain` | `49,493` fresh + `194,304` cached = `243,797` (`codex`; est. `49,940`, **0.99×**) | 44.9s (`44.5s` agent) | 0.99x (2-task serial plan) | No (`0`) | `46,012` fresh / `270,780` total / `43.7s` (`run-1795060615687534`, `--concurrency 1`) |
| 9.3 `clear()` + `isValidPriority` + `DELETE /tasks/:id` (`run-1795060673089688`) | `src/storage`, `src/domain`, `src/http` | `86,255` fresh + `216,576` cached = `302,831` (`codex` ×2 + `agy` ×1; est. `77,396`, **1.11×**) | 90.3s (`131.5s` agent) | **1.46x** | No (`0`) | — |

Pilot findings & observations:
- **Fixed during pilot:** headless `tf run` and `tf issue` previously did not pass `SemanticPlanner` / `OpenAIRoutingProvider` or `RepositoryProfile` (`repositoryMap`) to `RunOrchestrator`, causing headless runs to fall back to the 2-task serial `HeuristicPlanner` (`0.99x`). After wiring both, 3-area tasks split cleanly and reached **1.46x–1.65x** real parallelism across `codex` and `agy`.
- **Fresh tokens vs plan estimate (within 2× criterion):** separating `cached_input_tokens` from `fresh` work shows the plan estimator was accurate to **0.91×–1.14×** across every measured run (`codex` and `agy`). Codex's provider `total_tokens` includes ~85k–118k cached input tokens per assignment, which previously made `formatSpendLine` and `tf insights` look ~3.5×–4.8× off; both now surface fresh vs cached tokens explicitly when cache hits are present.
- **`tf insights --since 7` summary across pilot repo (12 runs):** 92% completion (11/12; only intentional Step 4b failed), `agents working 91% / checks 0% / TaskForge overhead 9%`, `codex` 18/19 avg `19s`, `agy` 6/6 avg `50s`.
- **Still open for 1.0 ([docs/release-criteria-1.0.md](release-criteria-1.0.md)):** `tf selftest` with a real agent on Linux (pipeline `--fake` + Docker container smoke now run in CI on `ubuntu-latest`), container pilot run by someone other than the author, and exercising the npm publish workflow with a pre-release tag (`v1.0.0-rc.1`).

A release candidate is ready for wider use when steps 1–7 pass with at least two different agents and no step produced an unreviewed change on your base branch.
