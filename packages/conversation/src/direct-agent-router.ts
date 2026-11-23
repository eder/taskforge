export type DirectRouteCommand =
  | { kind: 'shell'; command: string }
  | { kind: 'switch_mode'; mode: 'auto' | 'all' | string }
  | { kind: 'direct_agents'; targets: 'all' | 'smart' | string[]; prompt: string }
  | { kind: 'none' };

export interface OrchestratedAgentPreferences {
  implementer?: string;
  reviewer?: string;
  defaultAgent?: string;
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

  // 3. Leading `@agent` mentions (`@claude ...`, `@claude @codex ...`, `@all ...`, or bare `@claude`).
  if (text.startsWith('@')) {
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

    if (isAuto && rest.length === 0) {
      return { kind: 'switch_mode', mode: 'auto' };
    }
    if ((isAuto || isSmart) && rest.length > 0 && !isAll && targets.length === 0) {
      return {
        kind: 'direct_agents',
        targets: 'smart',
        prompt: rest,
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
