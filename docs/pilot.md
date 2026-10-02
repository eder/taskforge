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

A release candidate is ready for wider use when steps 1–7 pass with at least two different agents and no step produced an unreviewed change on your base branch.
