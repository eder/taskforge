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
# Tokens the agents used, per run
sqlite3 <db> "SELECT run_id, sum(total_tokens) AS tokens FROM cost_tracking GROUP BY run_id ORDER BY rowid DESC LIMIT 10;"

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

| Step | Agent(s) | Pass? | Notes / run id |
| --- | --- | --- | --- |
| 1 Read-only | | | |
| 2 Small implementation | | | |
| 3 Scope enforcement | | | |
| 4 Failure handling | | | |
| 5 Interrupt + resume | | | |
| 6 Cleanup | | | |
| 7 Credentials | | | |
| 8 Dual review | | | |

Measurements (step 9):

| Task | Areas touched | Tokens | Wall s | Parallelism | Serialized? | Single-agent tokens / wall s |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

A release candidate is ready for wider use when steps 1–7 pass with at least two different agents and no step produced an unreviewed change on your base branch.
