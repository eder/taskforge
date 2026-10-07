#!/usr/bin/env node
// Compares who plans best: OpenAI, a coding agent (Claude Code, Codex) or no model at all.
// The same goals, the same prompt, the same validator and the same scheduler metrics for every candidate.
//
//   node scripts/planner-ab/run.mjs --repo /path/to/project --candidates none,openai,codex,claude --yes
//
// "none" (no model: the built-in plan) costs nothing. openai, codex and claude spend real tokens: the experiment is printed
// first and nothing runs without --yes, a call limit and a token limit.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { measurePlan, parseClaudeOutput, parseCodexJsonl, summarize } from './metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (pkg) => import(path.join(root, 'packages', pkg, 'dist/index.js'));
const [{ SemanticPlanner }, scheduler, { RepositoryAnalyzer }, { loadConfig }] =
  await Promise.all([load('planner'), load('scheduler'), load('workspace'), load('shared')]);

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string', default: process.cwd() },
    goals: { type: 'string' },
    candidates: { type: 'string', default: 'none,openai,codex' },
    'max-agent-calls': { type: 'string', default: '8' },
    'max-agent-tokens': { type: 'string', default: '400000' },
    'timeout-seconds': { type: 'string', default: '180' },
    out: { type: 'string' },
    yes: { type: 'boolean', default: false },
  },
});

const repo = path.resolve(args.repo);
const timeoutMs = Number(args['timeout-seconds']) * 1000;
const goals = args.goals
  ? JSON.parse(fs.readFileSync(args.goals, 'utf8'))
  : [
      'Add a --json flag to `tf runs` and `tf doctor`, document it in the README and add tests',
      'Log SQLite queries slower than 200 ms and show how many there were in `tf insights`, with tests',
      'Add a /history slash command to the REPL that lists the last 10 goals, and document it in docs/usage.md',
      'Fix typos across the docs folder and add a CHANGELOG entry',
    ];
const candidates = args.candidates.split(',').map((c) => c.trim());
const paid = candidates.filter((c) => ['openai', 'codex', 'claude'].includes(c));
const agentCalls = candidates.filter((c) => ['codex', 'claude'].includes(c)).length * goals.length;

// --- plan the experiment before spending anything --------------------------------------------
console.log(`Repository: ${repo}`);
console.log(`Goals: ${goals.length}   Candidates: ${candidates.join(', ')}`);
console.log(`Agent calls: ${agentCalls} (limit ${args['max-agent-calls']}), token limit for agents: ${args['max-agent-tokens']}`);
if (paid.length > 0) {
  console.log('Real calls will be made for:', paid.join(', '), '(Codex alone uses ~15k input tokens per call before any work).');
  if (!args.yes) {
    console.log('\nNothing was run. Add --yes to spend tokens, or use --candidates none for a free run.');
    process.exit(0);
  }
}
if (agentCalls > Number(args['max-agent-calls'])) {
  console.error(`That is ${agentCalls} agent calls; raise --max-agent-calls or use fewer goals/candidates.`);
  process.exit(1);
}

// --- candidates --------------------------------------------------------------------------------
function run(command, argv, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout) resolve({ stdout, stderr, code });
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

const toPrompt = (messages) =>
  messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n') +
  '\n\nYou may read files of this repository, but do not change anything. Reply with ONLY the JSON object that matches the schema.';

let agentTokens = 0;
let lastTokens;
const callers = {
  codex: async (messages, schema) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ab-'));
    const schemaFile = path.join(dir, 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    try {
      const { stdout } = await run(
        'codex',
        ['exec', '--skip-git-repo-check', '-s', 'read-only', '--output-schema', schemaFile, '--json', '-C', repo, toPrompt(messages)],
        { cwd: repo },
      );
      const parsed = parseCodexJsonl(stdout);
      lastTokens = parsed.tokens;
      return parsed.plan;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  claude: async (messages, schema) => {
    const { stdout } = await run(
      'claude',
      ['-p', toPrompt(messages), '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--allowedTools', 'Read', 'Grep', 'Glob', '--max-turns', '8'],
      { cwd: repo },
    );
    const parsed = parseClaudeOutput(stdout);
    lastTokens = parsed.tokens;
    return parsed.plan;
  },
};

const config = loadConfig(path.join(repo, '.taskforge/config.yaml'));
const profile = await new RepositoryAnalyzer(repo).analyze();
const toolsFor = (graph) => ({
  planWidth: scheduler.planWidth,
  // The scheduler orders prerequisites first before deciding what to serialize.
  dependenciesToSerialize: () => scheduler.dependenciesToSerialize(graph.topologicalSort()),
  taskProducesChanges: scheduler.taskProducesChanges,
  exists: (p) => fs.existsSync(path.join(repo, p)),
});

function plannerFor(candidate) {
  const common = { maxTasks: config.planner?.maxTasks };
  if (candidate === 'none') return new SemanticPlanner({ ...common, apiKey: undefined });
  if (candidate === 'openai') {
    return new SemanticPlanner({ ...common, model: process.env.PLANNER_MODEL || config.router?.model, timeoutMs });
  }
  return new SemanticPlanner({ ...common, apiKey: undefined, customCaller: callers[candidate] });
}

// --- run ---------------------------------------------------------------------------------------
const results = [];
for (const [index, description] of goals.entries()) {
  for (const candidate of candidates) {
    if (candidate === 'openai' && !(process.env.TASKFORGE_OPENAI_API_KEY || process.env.OPENAI_API_KEY)) {
      results.push({ goal: index, candidate, status: 'skipped', error: 'no OpenAI key', ms: 0 });
      continue;
    }
    if (['codex', 'claude'].includes(candidate) && agentTokens >= Number(args['max-agent-tokens'])) {
      results.push({ goal: index, candidate, status: 'skipped', error: 'agent token limit reached', ms: 0 });
      continue;
    }
    lastTokens = undefined;
    const started = Date.now();
    const goal = { id: `ab-${index}`, description, repository: repo, constraints: [], acceptanceCriteria: [], createdAt: new Date() };
    try {
      const graph = await plannerFor(candidate).plan(goal, profile);
      const planner = graph.metadata?.planner ?? {};
      const modelPlan = planner.source === 'semantic_model';
      if (lastTokens) agentTokens += lastTokens;
      results.push({
        goal: index,
        candidate,
        status: modelPlan ? 'model_plan' : 'fallback',
        reason: modelPlan ? undefined : (planner.fallbackReason ?? planner.source),
        ms: Date.now() - started,
        tokens: lastTokens,
        metrics: measurePlan(graph.getAllTasks(), toolsFor(graph)),
        tasks: graph.getAllTasks().map((t) => ({ id: t.id, title: t.title, type: t.type, scope: t.contract.allowedScope, deps: t.dependencies })),
      });
    } catch (error) {
      if (lastTokens) agentTokens += lastTokens;
      results.push({ goal: index, candidate, status: 'error', error: String(error.message ?? error), ms: Date.now() - started, tokens: lastTokens });
    }
    const last = results[results.length - 1];
    console.log(`  goal ${index + 1} / ${candidate}: ${last.status}${last.reason ? ` (${last.reason})` : ''}${last.error ? ` - ${last.error}` : ''} in ${(last.ms / 1000).toFixed(1)}s`);
  }
}

// --- report ------------------------------------------------------------------------------------
const fmt = (v, digits = 1) => (v === undefined ? '-' : Number(v).toFixed(digits));
console.log('\ncandidate  calls  own-plan  median s  avg tokens  tasks  width  serialized  repo-wide  real scopes');
for (const s of summarize(results)) {
  console.log(
    [
      s.candidate.padEnd(9),
      String(s.calls).padStart(5),
      `${s.modelPlans}/${s.calls}`.padStart(9),
      fmt(s.medianSeconds).padStart(9),
      fmt(s.avgTokens, 0).padStart(11),
      fmt(s.avgTasks).padStart(6),
      fmt(s.avgWidth).padStart(6),
      fmt(s.avgSerializedBy).padStart(11),
      fmt(s.avgRepoWideScopes).padStart(10),
      s.avgRealScopeRatio === undefined ? '-'.padStart(12) : `${Math.round(s.avgRealScopeRatio * 100)}%`.padStart(12),
    ].join('  '),
  );
}
console.log('\nown-plan: the candidate\'s own valid plan was used (not the built-in fallback). width: tasks that can run together after the scheduler orders overlapping writers.');
const out = args.out ?? path.join(os.tmpdir(), `planner-ab-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify({ repo, goals, candidates, results }, null, 2));
console.log(`Details: ${out}`);
