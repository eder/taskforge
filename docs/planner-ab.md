# Who should plan: OpenAI, a coding agent, or nothing?

TaskForge asks a model to turn a goal into tasks with non-overlapping scopes; that is what lets independent tasks run at the same time. Today that call goes to OpenAI. Without an OpenAI key the built-in planner is used, which gives a fixed plan with repository-wide write scopes, so its tasks run one after another.

`scripts/planner-ab/run.mjs` compares the candidates on the same goals, with the same prompt, the same validator and the numbers the real scheduler acts on:

```bash
pnpm build
# free: the built-in plan, no model
node scripts/planner-ab/run.mjs --repo /path/to/project --candidates none

# real calls (spends tokens): needs --yes, and stops at the limits
node scripts/planner-ab/run.mjs --repo /path/to/project --candidates none,openai,codex,claude \
  --goals goals.json --max-agent-calls 12 --max-agent-tokens 400000 --yes
```

`goals.json` is an array of goal texts, ideally 8 to 10 real goals of the project, including some that touch more than one area. Without it four sample goals are used.

| Column | Meaning |
| --- | --- |
| own-plan | the candidate's own valid plan was used, not the built-in fallback |
| median s / avg tokens | time and tokens of the planning call (OpenAI tokens are not reported by the planner) |
| tasks | tasks per plan |
| width | tasks that can run together after the scheduler orders writers whose scopes may overlap (**the parallelism the plan allows**) |
| serialized | extra orderings the scheduler had to add |
| repo-wide | write scopes that cover the whole repository (they force serial work) |
| real scopes | share of the specific scopes that point at a path that exists (low = invented paths) |

Notes:

- Codex spends about 15,000 input tokens per call before doing any work; Claude Code and Codex are run read-only with a turn limit, but an agent may still read many files.
- A candidate that is not signed in or out of quota is recorded as an error, which is itself a result.
- Per-call details, including each plan's tasks and scopes, are written to a JSON file (`--out`).
- Judge plan quality by reading a few of those plans; the numbers say how much parallel work a plan allows, not whether the decomposition is right.
