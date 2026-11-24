import { AGENT_EFFORT_LEVELS, type AgentEffortLevel } from '@taskforge/shared';

export type DirectRouteCommand =
  | { kind: 'shell'; command: string }
  | { kind: 'switch_mode'; mode: 'auto' | 'all' | string }
  | { kind: 'direct_agents'; targets: 'all' | 'smart' | string[]; prompt: string; editMode?: boolean }
  | { kind: 'direct_pipeline'; stages: string[]; prompt: string }
  | { kind: 'direct_debate'; targets: 'all' | string[]; prompt: string }
  | {
      kind: 'model_config';
      action: 'show' | 'set' | 'reset';
      agentId?: string;
      model?: string;
      effort?: AgentEffortLevel;
      error?: string;
    }
  | { kind: 'none' };

export interface OrchestratedAgentPreferences {
  implementer?: string;
  reviewer?: string;
  defaultAgent?: string;
}

export interface NaturalConfigUpdate {
  keyPath: string[];
  value: number | string | null;
  label: string;
  action?: 'set' | 'delete';
}

export interface NaturalConfigChange {
  updates: NaturalConfigUpdate[];
  language: 'pt' | 'en';
}

const AGENT_ALIASES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  agy: 'agy',
  antigravity: 'agy',
  cursor: 'cursor',
  aider: 'aider',
  opencode: 'opencode',
  goose: 'goose',
  ollama: 'ollama',
};

const ALL_ALIASES = new Set(['all', 'todos', 'every', 'everyone']);
const AUTO_ALIASES = new Set(['auto', 'orchestrator', 'hybrid', 'hibrido', 'híbrido', 'default', 'tf']);
const SMART_ALIASES = new Set(['smart', 'best', 'melhor']);

export function normalizeAgentAlias(token: string): string | undefined {
  return AGENT_ALIASES[token.toLowerCase()];
}

/**
 * Parses direct agent interface syntax at the REPL prompt:
 * - `!<cmd>` — direct local shell command (captured into shared session memory)
 * - `/use <claude|codex|agy|all|auto>` — switch sticky direct chat target
 * - `@claude` / `@codex` / `@agy` / `@all` / `@auto` (bare) — switch sticky target
 * - `@claude <msg>` / `@claude @codex <msg>` / `@all <msg>` — invoke one or more
 *   agents directly without Plan Proposal / Worktree ceremony
 */
export function parseDirectRouteCommand(
  rawInput: string,
  knownAgentIds?: Iterable<string>,
): DirectRouteCommand {
  const text = rawInput.trim();
  if (!text) return { kind: 'none' };

  // 1. Direct local shell escape (`!git status`, `!pytest -q`).
  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (command.length > 0) {
      return { kind: 'shell', command };
    }
    return { kind: 'none' };
  }

  const known = new Set<string>(knownAgentIds ? [...knownAgentIds].map((id) => id.toLowerCase()) : []);
  const resolveKnownAgent = (token: string): string | undefined => {
    const lower = token.toLowerCase();
    const mapped = AGENT_ALIASES[lower];
    if (mapped) return mapped;
    if (known.has(lower)) return lower;
    return undefined;
  };

  // 2. Sticky mode command: `/use <agent|all|auto>`
  const useMatch = /^\/use(?:\s+(@?[a-zA-Z0-9_-]+))?$/i.exec(text);
  if (useMatch) {
    const rawTarget = (useMatch[1] ?? '').replace(/^@/, '').toLowerCase();
    if (!rawTarget || AUTO_ALIASES.has(rawTarget)) {
      return { kind: 'switch_mode', mode: 'auto' };
    }
    if (ALL_ALIASES.has(rawTarget)) {
      return { kind: 'switch_mode', mode: 'all' };
    }
    const agent = resolveKnownAgent(rawTarget);
    if (agent) {
      return { kind: 'switch_mode', mode: agent };
    }
    return { kind: 'switch_mode', mode: rawTarget };
  }

  // 2b. Per-agent model & effort selector: `/model`, `/model codex o3`, `/model codex o3 high`, `/model codex effort high`, `/model codex reset`
  const modelMatch = /^\/model(?:\s+(.*))?$/i.exec(text);
  if (modelMatch) {
    const rest = (modelMatch[1] ?? '').trim();
    if (!rest) {
      return { kind: 'model_config', action: 'show' };
    }
    const tokens = rest.split(/\s+/).filter(Boolean);
    const rawAgent = tokens[0].replace(/^@/, '').toLowerCase();
    const agentId = resolveKnownAgent(rawAgent);
    if (!agentId) {
      return {
        kind: 'model_config',
        action: 'show',
        error: `Unknown agent "${tokens[0]}". Try: /model codex o3, /model claude sonnet, /model agy gemini-2.5-pro.`,
      };
    }
    if (tokens.length === 1) {
      return { kind: 'model_config', action: 'show', agentId };
    }
    const second = tokens[1].toLowerCase();
    if (second === 'reset' || second === 'default' || second === 'clear' || second === 'none') {
      return { kind: 'model_config', action: 'reset', agentId };
    }
    if (second === 'effort') {
      const eff = (tokens[2] ?? '').toLowerCase();
      if (!eff || eff === 'reset' || eff === 'default') {
        return { kind: 'model_config', action: 'reset', agentId, model: '__effort_only__' };
      }
      if (!(AGENT_EFFORT_LEVELS as readonly string[]).includes(eff)) {
        return {
          kind: 'model_config',
          action: 'show',
          error: `Unknown effort "${tokens[2]}". Valid levels: ${AGENT_EFFORT_LEVELS.join(', ')}.`,
        };
      }
      return {
        kind: 'model_config',
        action: 'set',
        agentId,
        effort: eff as AgentEffortLevel,
      };
    }
    const modelName = tokens[1];
    const third = tokens[2]?.toLowerCase();
    if (third) {
      const normalizedEff = third.replace(/^--?effort=/, '');
      if (!(AGENT_EFFORT_LEVELS as readonly string[]).includes(normalizedEff)) {
        return {
          kind: 'model_config',
          action: 'show',
          error: `Unknown effort "${tokens[2]}". Valid levels: ${AGENT_EFFORT_LEVELS.join(', ')}.`,
        };
      }
      return {
        kind: 'model_config',
        action: 'set',
        agentId,
        model: modelName,
        effort: normalizedEff as AgentEffortLevel,
      };
    }
    return {
      kind: 'model_config',
      action: 'set',
      agentId,
      model: modelName,
    };
  }

  // 3. Leading `@agent` mentions:
  //    - `@codex -> @agy <task>` / `@codex -> @agy -> @claude <task>` (Direct Handoff Pipeline)
  //    - `@codex <-> @agy <question>` / `@all <-> <question>` (2-Round Structured Direct Debate)
  //    - `@claude ...`, `@claude @codex ...`, `@all ...`, or bare `@claude`
  if (text.startsWith('@')) {
    // 3a. Structured Direct Debate (`<->` or `↔`): `@codex <-> @agy <question>` or `@all <-> <question>`
    const allDebateMatch = /^@(all|todos|every|everyone)\s*(?:<->|↔)\s+(.+)$/i.exec(text);
    if (allDebateMatch) {
      return {
        kind: 'direct_debate',
        targets: 'all',
        prompt: allDebateMatch[2].trim(),
      };
    }
    const debateChainMatch =
      /^(@[a-zA-Z0-9_-]+(?:\s*(?:<->|↔)\s*@[a-zA-Z0-9_-]+)+)(?:[:,])?\s+(.+)$/.exec(text);
    if (debateChainMatch) {
      const rawAgents = debateChainMatch[1]
        .split(/\s*(?:<->|↔)\s*/)
        .map((t) => t.replace(/^@/, '').trim());
      const resolved: string[] = [];
      let valid = true;
      for (const tok of rawAgents) {
        const agent = resolveKnownAgent(tok);
        if (!agent) {
          valid = false;
          break;
        }
        if (!resolved.includes(agent)) resolved.push(agent);
      }
      if (valid && resolved.length >= 2) {
        return {
          kind: 'direct_debate',
          targets: resolved,
          prompt: debateChainMatch[2].trim(),
        };
      }
    }

    // 3b. Direct Handoff Pipeline (`->`, `=>`, or `→`): `@codex -> @agy <task>`
    const pipelineChainMatch =
      /^(@[a-zA-Z0-9_-]+(?:\s*(?:->|=>|→)\s*@[a-zA-Z0-9_-]+)+)(?:[:,])?\s+(.+)$/.exec(text);
    if (pipelineChainMatch) {
      const rawStages = pipelineChainMatch[1]
        .split(/\s*(?:->|=>|→)\s*/)
        .map((t) => t.replace(/^@/, '').trim());
      const stages: string[] = [];
      let valid = true;
      for (const tok of rawStages) {
        const lower = tok.toLowerCase();
        if (SMART_ALIASES.has(lower) || AUTO_ALIASES.has(lower)) {
          stages.push('smart');
          continue;
        }
        const agent = resolveKnownAgent(tok);
        if (!agent) {
          valid = false;
          break;
        }
        stages.push(agent);
      }
      if (valid && stages.length >= 2) {
        return {
          kind: 'direct_pipeline',
          stages,
          prompt: pipelineChainMatch[2].trim(),
        };
      }
    }

    let rest = text;
    const targets: string[] = [];
    let isAll = false;
    let isAuto = false;
    let isSmart = false;

    while (rest.startsWith('@')) {
      const match = /^@([a-zA-Z0-9_-]+)(?:[:,])?(?:\s+|$)/.exec(rest);
      if (!match) break;
      const token = match[1].toLowerCase();
      if (ALL_ALIASES.has(token)) {
        isAll = true;
      } else if (AUTO_ALIASES.has(token)) {
        isAuto = true;
      } else if (SMART_ALIASES.has(token)) {
        isSmart = true;
      } else {
        const agent = resolveKnownAgent(token);
        if (!agent) {
          // Not a recognized agent mention (e.g. a file path like `@src/app.ts` or decorator `@dataclass`).
          if (targets.length === 0 && !isAll && !isAuto && !isSmart) {
            return { kind: 'none' };
          }
          break;
        }
        if (!targets.includes(agent)) targets.push(agent);
      }
      rest = rest.slice(match[0].length).trimStart();
    }

    let editMode = false;
    const editFlagMatch = /^--(?:edit|compete)\b\s*/i.exec(rest);
    if (editFlagMatch) {
      editMode = true;
      rest = rest.slice(editFlagMatch[0].length).trimStart();
    }

    if (isAuto && rest.length === 0) {
      return { kind: 'switch_mode', mode: 'auto' };
    }
    if ((isAuto || isSmart) && rest.length > 0 && !isAll && targets.length === 0) {
      return {
        kind: 'direct_agents',
        targets: 'smart',
        prompt: rest,
        ...(editMode ? { editMode: true } : {}),
      };
    }
    if (isAll && rest.length === 0) {
      return { kind: 'switch_mode', mode: 'all' };
    }
    if (targets.length === 1 && !isAll && rest.length === 0) {
      return { kind: 'switch_mode', mode: targets[0] };
    }
    if ((isAll || targets.length > 0) && rest.length > 0) {
      return {
        kind: 'direct_agents',
        targets: isAll ? 'all' : targets,
        prompt: rest,
        ...(editMode ? { editMode: true } : {}),
      };
    }
  }

  return { kind: 'none' };
}

/**
 * Extracts explicit natural-language agent role preferences from an orchestrated
 * goal (PT & EN), e.g.:
 * - "usa o claude para implementar a autenticação" -> { implementer: 'claude', defaultAgent: 'claude' }
 * - "pede pro claude implementar e pro codex revisar X" -> { implementer: 'claude', reviewer: 'codex' }
 * - "use codex to implement and claude to review" -> { implementer: 'codex', reviewer: 'claude' }
 */
export function extractOrchestratedAgentPreferences(rawText: string): OrchestratedAgentPreferences {
  const lower = rawText.toLowerCase();
  const prefs: OrchestratedAgentPreferences = {};

  const agentPattern = '(claude|codex|antigravity|agy)';
  const implVerb =
    '(?:implement\\w*|cod(?:ar|e|ificar)|escrev\\w*|faz(?:er)?|cria(?:r)?|corrig\\w*|edit\\w*|build\\w*|write|fix)';
  const revVerb = '(?:revis\\w*|review\\w*|audit\\w*|verific\\w*|checa\\w*|check\\w*|validat\\w*)';

  // Role-specific pairs: "<agent> ... <implVerb>" / "<agent> ... <revVerb>"
  const implRe = new RegExp(`\\b${agentPattern}\\b[^,.;\\n]{0,24}\\b${implVerb}\\b`, 'i');
  const revRe = new RegExp(`\\b${agentPattern}\\b[^,.;\\n]{0,24}\\b${revVerb}\\b`, 'i');

  const implMatch = implRe.exec(lower);
  if (implMatch) {
    prefs.implementer = normalizeAgentAlias(implMatch[1]);
  }
  const revMatch = revRe.exec(lower);
  if (revMatch) {
    prefs.reviewer = normalizeAgentAlias(revMatch[1]);
  }

  // Generic single-agent directive: "usa o claude ...", "com o codex ...", "use claude to ..."
  if (!prefs.implementer && !prefs.reviewer) {
    const singleRe = new RegExp(
      `\\b(?:usa(?:r)?|use|com|with|via|pelo|pede\\s+(?:pro|para\\s+o|ao)|ask)\\s+(?:o\\s+)?${agentPattern}\\b`,
      'i',
    );
    const singleMatch = singleRe.exec(lower);
    if (singleMatch) {
      prefs.defaultAgent = normalizeAgentAlias(singleMatch[1]);
    }
  }

  return prefs;
}

const PT_CONFIG_CUE =
  /\b(?:usa(?:r)?|quero|coloca(?:r)?|define|definir|configura(?:r)?|muda(?:r)?|altera(?:r)?|aumenta(?:r)?|sobe|subir|diminui(?:r)?|limita(?:r)?|remove(?:r)?|tira(?:r)?|sem\s+limite|paralelo|paralelismo|at[eé]|para|agentes?|simult[aâ]ne\w*)\b/i;
const CODE_TASK_GUARD =
  /\b(?:implement\w*|cria(?:r)?\s+(?:um|uma)|create\s+a|refactor\w*|refator\w*|endpoint|fun[çc][aã]o|function|class\b|classe\b|arquivo|file\b|testes?|tests?\b|bug\b|erro\b|fix\b|corrig\w*)\b|\.(?:ts|tsx|js|jsx|py|go|rs|swift|java)\b/i;

function parseTokenAmount(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/\s+/g, '');
  const suffixMatch = /^(\d+(?:[.,]\d+)?)\s*([km])$/i.exec(cleaned);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1].replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) return undefined;
    const mult = suffixMatch[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
    return Math.round(num * mult);
  }
  // Support 4_000_000, 4,000,000, or Brazilian 4.000.000
  if (/^\d{1,3}(?:[._,]\d{3})+$/.test(cleaned)) {
    const digits = cleaned.replace(/[._,]/g, '');
    const n = parseInt(digits, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  if (/^\d+$/.test(cleaned)) {
    const n = parseInt(cleaned, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Parses natural-language TaskForge configuration commands (PT & EN) so users
 * can adjust parallelism and token budgets directly in conversation without
 * editing `.taskforge/config.yaml` by hand.
 *
 * Examples:
 * - "usa até 5 codex e 5 agy em paralelo"
 * - "aumenta o paralelismo para 10"
 * - "aumenta o limite de tokens para 4M"
 * - "sem limite de tokens"
 * - "use up to 4 codex and 3 agy in parallel"
 * - "set token budget to 2.5M"
 */
export function parseNaturalConfigChange(rawText: string): NaturalConfigChange | undefined {
  const text = rawText.trim();
  if (!text || text.startsWith('/') || text.startsWith('@') || text.startsWith('!')) {
    return undefined;
  }
  // Keep this strictly for short configuration directives, never engineering tasks.
  if (text.length > 180 || text.includes('?') || CODE_TASK_GUARD.test(text)) {
    return undefined;
  }

  const lower = text.toLowerCase();
  const language: 'pt' | 'en' = PT_CONFIG_CUE.test(lower) ? 'pt' : 'en';
  const updates: NaturalConfigUpdate[] = [];
  const seenKeys = new Set<string>();
  const pushUpdate = (
    keyPath: string[],
    value: number | string | null,
    label: string,
    action: 'set' | 'delete' = 'set',
  ) => {
    const key = keyPath.join('.');
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    updates.push({ keyPath, value, label, action });
  };

  const hasParallelDirective =
    /\b(?:paralel\w*|parallel\w*|simult[aâ]ne\w*|concorrent\w*|concurrent\w*|maxparallel|usa(?:r)?\s+at[eé]|use\s+up\s+to|quero\s+(?:usar\s+)?\d+|coloca(?:r)?\s+(?:at[eé]\s+)?\d+|configura(?:r)?|define|definir|set\b|aumenta(?:r)?|increase|diminui(?:r)?|limita(?:r)?)\b/i.test(
      lower,
    );

  // 1. Per-agent parallelism: "5 codex e 5 agy", "codex com 4", "codex maxParallel 3"
  const agentCounts = new Map<string, number>();
  if (hasParallelDirective) {
    const numBeforeAgent = /\b(\d{1,2})\s+(claude|codex|antigravity|agy)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = numBeforeAgent.exec(lower)) !== null) {
      const count = Math.max(1, Math.min(10, parseInt(m[1], 10)));
      const agentId = normalizeAgentAlias(m[2]);
      if (agentId) agentCounts.set(agentId, count);
    }
    const agentBeforeNum =
      /\b(claude|codex|antigravity|agy)\b\s*(?:maxparallel|paralel\w*|parallel\w*|com|with|para|to|=|:)\s*(?:at[eé]|up\s+to)?\s*(\d{1,2})\b/gi;
    while ((m = agentBeforeNum.exec(lower)) !== null) {
      const agentId = normalizeAgentAlias(m[1]);
      const count = Math.max(1, Math.min(10, parseInt(m[2], 10)));
      if (agentId && !agentCounts.has(agentId)) agentCounts.set(agentId, count);
    }
  }

  let perAgentTotal = 0;
  for (const [agentId, count] of agentCounts.entries()) {
    perAgentTotal += count;
    pushUpdate(['agents', agentId, 'maxParallel'], count, `agents.${agentId}.maxParallel = ${count}`);
  }

  // 2. Global parallelism: "aumenta o paralelismo para 10", "set parallelism to 8", "usa até 8 agentes em paralelo"
  const globalParallelMatch =
    /\b(?:paralelismo|parallelism|max[\s_-]*parallel(?:[\s_-]*tasks?)?|concorr[eê]ncia|concurrency)\b[^0-9]{0,20}(\d{1,2})\b/i.exec(
      lower,
    ) ??
    /\b(?:usa(?:r)?|use|coloca(?:r)?|define|set|aumenta(?:r)?|increase|at[eé]|up\s+to)\s+(?:at[eé]\s+|up\s+to\s+)?(\d{1,2})\s+(?:agentes?|agents?|tasks?|tarefas?)\s+(?:em\s+paralelo|in\s+parallel|simult[aâ]ne\w*|concorrent\w*)\b/i.exec(
      lower,
    );

  if (globalParallelMatch) {
    const n = Math.max(1, Math.min(20, parseInt(globalParallelMatch[1], 10)));
    pushUpdate(['execution', 'maxParallelTasks'], n, `execution.maxParallelTasks = ${n}`);
    if (n > 8) {
      pushUpdate(['planner', 'maxTasks'], Math.min(20, n), `planner.maxTasks = ${Math.min(20, n)}`);
    }
  } else if (perAgentTotal > 0) {
    const targetParallel = Math.max(2, Math.min(20, perAgentTotal));
    pushUpdate(
      ['execution', 'maxParallelTasks'],
      targetParallel,
      `execution.maxParallelTasks = ${targetParallel}`,
    );
    if (targetParallel > 8) {
      pushUpdate(
        ['planner', 'maxTasks'],
        Math.min(20, targetParallel),
        `planner.maxTasks = ${Math.min(20, targetParallel)}`,
      );
    }
  }

  // 3. Token budget: "aumenta o limite de tokens para 4M", "sem limite de tokens", "set token budget to 2.5m"
  const unlimitedTokens =
    /\b(?:sem\s+limite\s+de\s+tokens?|remove(?:r)?\s+(?:o\s+)?limite\s+de\s+tokens?|tira(?:r)?\s+(?:o\s+)?limite\s+de\s+tokens?|no\s+token\s+(?:limit|budget|cap)|unlimited\s+tokens?|disable\s+token\s+(?:limit|budget|cap)|desativa(?:r)?\s+(?:o\s+)?limite\s+de\s+tokens?)\b/i.test(
      lower,
    );
  if (unlimitedTokens) {
    pushUpdate(['execution', 'tokenBudget'], 0, 'execution.tokenBudget = 0 (unlimited)');
  } else {
    const budgetMatch =
      /\b(?:limite\s+de\s+tokens?|budget\s+de\s+tokens?|or[çc]amento\s+de\s+tokens?|token\s*(?:budget|limit|cap)|teto\s+de\s+tokens?)\b[^0-9]{0,20}(\d+(?:[.,_]\d+)*\s*[km]?)\b/i.exec(
        lower,
      ) ??
      /\b(?:aumenta(?:r)?|sobe|subir|muda(?:r)?|altera(?:r)?|coloca(?:r)?|define|set|increase|raise)\b[^0-9]{0,24}(\d+(?:[.,_]\d+)*\s*[km])\s*tokens?\b/i.exec(
        lower,
      );
    if (budgetMatch) {
      const amount = parseTokenAmount(budgetMatch[1]);
      if (amount !== undefined && (amount === 0 || amount >= 10_000)) {
        const display = amount === 0 ? '0 (unlimited)' : amount.toLocaleString('en-US');
        pushUpdate(['execution', 'tokenBudget'], amount, `execution.tokenBudget = ${display}`);
      }
    }
  }

  // 4. Per-agent model & reasoning effort overrides (PT & EN):
  //    - "usa o modelo o3 no codex", "troca o modelo do claude para sonnet", "use model gemini-2.5-pro on agy"
  //    - "coloca effort high no codex", "set codex effort to high"
  //    - "reseta o modelo do codex", "reset codex model"
  const resetModelMatch =
    /\b(?:reseta(?:r)?|limpa(?:r)?|volta(?:r)?\s+ao\s+padr[aã]o|reset|clear)\s+(?:o\s+|the\s+)?(?:modelo|model)\s+(?:do\s+|da\s+|no\s+|on\s+|for\s+|of\s+)?(claude|codex|antigravity|agy)\b/i.exec(
      text,
    ) ??
    /\b(?:reseta(?:r)?|reset|clear)\s+(claude|codex|antigravity|agy)\s+(?:modelo|model)\b/i.exec(text);
  if (resetModelMatch) {
    const agentId = normalizeAgentAlias(resetModelMatch[1]);
    if (agentId) {
      pushUpdate(['agents', agentId, 'model'], null, `agents.${agentId}.model = (CLI default)`, 'delete');
      pushUpdate(['agents', agentId, 'effort'], null, `agents.${agentId}.effort = (CLI default)`, 'delete');
    }
  } else {
    const modelPatterns: Array<{ re: RegExp; modelIdx: number; agentIdx: number }> = [
      // "usa o modelo o3 no codex" / "use model o3 on codex" / "define modelo sonnet para claude"
      {
        re: /\b(?:usa(?:r)?|use|coloca(?:r)?|define|definir|muda(?:r)?|altera(?:r)?|troca(?:r)?|set|switch)\s+(?:o\s+|the\s+)?(?:modelo|model)\s+([a-zA-Z0-9._:/-]+)\s+(?:no|na|pro|para\s+o|para|do|em|on|for|in)\s+(claude|codex|antigravity|agy)\b/i,
        modelIdx: 1,
        agentIdx: 2,
      },
      // "troca o modelo do codex para o3" / "set codex model to o3" / "muda modelo do agy pra gemini-2.5-pro"
      {
        re: /\b(?:usa(?:r)?|use|coloca(?:r)?|define|definir|muda(?:r)?|altera(?:r)?|troca(?:r)?|set|switch)\s+(?:o\s+|the\s+)?(?:modelo|model)\s+(?:do|da|no|for|of|on)\s+(claude|codex|antigravity|agy)\s+(?:para|pra|to|as|=)\s+([a-zA-Z0-9._:/-]+)\b/i,
        modelIdx: 2,
        agentIdx: 1,
      },
      // "set codex model to o3" / "switch claude model to sonnet"
      {
        re: /\b(?:set|use|switch|change)\s+(claude|codex|antigravity|agy)\s+model\s+(?:to|as|=)\s+([a-zA-Z0-9._:/-]+)\b/i,
        modelIdx: 2,
        agentIdx: 1,
      },
    ];
    for (const pat of modelPatterns) {
      const m = pat.re.exec(text);
      if (m) {
        const agentId = normalizeAgentAlias(m[pat.agentIdx]);
        const modelName = m[pat.modelIdx].replace(/[,.;!?]+$/, '');
        if (agentId && modelName) {
          pushUpdate(['agents', agentId, 'model'], modelName, `agents.${agentId}.model = ${modelName}`);
          break;
        }
      }
    }

    const effortLevelPattern = AGENT_EFFORT_LEVELS.join('|');
    const effortReA = new RegExp(
      `\\b(?:usa(?:r)?|use|coloca(?:r)?|define|definir|muda(?:r)?|altera(?:r)?|set)\\s+(?:o\\s+)?(?:effort|esfor[çc]o|reasoning(?:\\s+effort)?)\\s+(?:para\\s+|to\\s+)?(${effortLevelPattern})\\s+(?:no|na|pro|para\\s+o|do|on|for)\\s+(claude|codex|antigravity|agy)\\b`,
      'i',
    );
    const effortReB = new RegExp(
      `\\b(?:set|usa(?:r)?|use|coloca(?:r)?|muda(?:r)?|altera(?:r)?)\\s+(?:o\\s+)?(claude|codex|antigravity|agy)\\s+(?:em\\s+|com\\s+)?(?:effort|esfor[çc]o|reasoning(?:\\s+effort)?)\\s*(?:para|to|=|:)?\\s*(${effortLevelPattern})\\b`,
      'i',
    );
    const effA = effortReA.exec(text);
    const effB = !effA ? effortReB.exec(text) : null;
    if (effA) {
      const agentId = normalizeAgentAlias(effA[2]);
      const eff = effA[1].toLowerCase();
      if (agentId) pushUpdate(['agents', agentId, 'effort'], eff, `agents.${agentId}.effort = ${eff}`);
    } else if (effB) {
      const agentId = normalizeAgentAlias(effB[1]);
      const eff = effB[2].toLowerCase();
      if (agentId) pushUpdate(['agents', agentId, 'effort'], eff, `agents.${agentId}.effort = ${eff}`);
    }
  }

  if (updates.length === 0) return undefined;
  return { updates, language };
}
