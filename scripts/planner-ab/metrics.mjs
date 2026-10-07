// Pure helpers for the planner A/B: what to measure on a plan and how to read agent CLI output.
// Kept free of I/O (the repository is checked through an injected `exists`) so they can be tested.

/** Directory a scope pattern starts in ("src/storage/**" -> "src/storage"; "src/a.ts" -> "src/a.ts"). */
export function staticPrefix(scope) {
  const pattern = scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (pattern === '' || pattern === '*' || pattern === '**') return undefined;
  const wildcard = pattern.search(/[*?[{]/);
  if (wildcard === -1) return pattern;
  const head = pattern.slice(0, wildcard);
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/')) : '';
}

/**
 * What a plan offers for parallel work and how trustworthy its scopes are.
 * `tools` come from the scheduler (planWidth, dependenciesToSerialize, taskProducesChanges),
 * so the numbers are the ones the real scheduler would act on.
 */
export function measurePlan(tasks, { planWidth, dependenciesToSerialize, taskProducesChanges, exists }) {
  const writers = tasks.filter(taskProducesChanges);
  const scopes = writers.flatMap((t) => t.contract.allowedScope ?? []);
  const repoWide = scopes.filter((s) => staticPrefix(s) === undefined || staticPrefix(s) === '');
  const specific = scopes.filter((s) => !repoWide.includes(s));
  const real = specific.filter((s) => exists(staticPrefix(s)));
  return {
    tasks: tasks.length,
    writers: writers.length,
    // Tasks the scheduler could run together once overlapping writers are ordered.
    width: planWidth(tasks),
    // Extra orderings the scheduler had to add because writable scopes may overlap.
    serializedBy: dependenciesToSerialize(tasks).length,
    repoWideScopes: repoWide.length,
    // Share of the specific scopes that point at a path that exists (1 = none invented).
    realScopeRatio: specific.length === 0 ? undefined : real.length / specific.length,
  };
}

/** Claude Code `--output-format json` result: the plan and the tokens used. */
export function parseClaudeOutput(stdout) {
  const out = JSON.parse(stdout);
  if (out.is_error) throw new Error(String(out.result ?? 'claude reported an error'));
  const plan = out.structured_output ?? JSON.parse(out.result);
  const u = out.usage ?? {};
  const tokens =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return { plan, tokens, costUsd: out.total_cost_usd };
}

/** Codex `exec --json` output (JSONL): the last agent message is the plan; usage is on turn.completed. */
export function parseCodexJsonl(stdout) {
  let message;
  let tokens = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text;
    if (event.type === 'turn.completed' && event.usage) {
      tokens += (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0);
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      throw new Error(String(event.message ?? event.error?.message ?? 'codex reported an error'));
    }
  }
  if (message === undefined) throw new Error('codex returned no final message');
  return { plan: JSON.parse(message), tokens };
}

export function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

/** One row per candidate from the per-call results. */
export function summarize(results) {
  const byCandidate = new Map();
  for (const r of results) byCandidate.set(r.candidate, [...(byCandidate.get(r.candidate) ?? []), r]);
  return [...byCandidate.entries()].map(([candidate, rows]) => {
    const planned = rows.filter((r) => r.status === 'model_plan');
    // "none" has no model: its (built-in) plan is the whole answer, so it is measured as it is.
    const measured = candidate === 'none' ? rows.filter((r) => r.metrics) : planned;
    const pick = (key) => measured.map((r) => r.metrics?.[key]).filter((v) => v !== undefined);
    return {
      candidate,
      calls: rows.length,
      modelPlans: planned.length, // the model's own plan was valid and used (not a fallback)
      medianSeconds: median(rows.map((r) => r.ms / 1000)),
      avgTokens: mean(rows.map((r) => r.tokens).filter((v) => v !== undefined)),
      avgTasks: mean(pick('tasks')),
      avgWidth: mean(pick('width')),
      avgSerializedBy: mean(pick('serializedBy')),
      avgRepoWideScopes: mean(pick('repoWideScopes')),
      avgRealScopeRatio: mean(pick('realScopeRatio')),
    };
  });
}
