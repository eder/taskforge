export type ProblemSize = 'small' | 'medium' | 'large';

export interface ProblemAssessmentInput {
  /** Failure evidence, error log, or user request text. */
  text: string;
  /** Number of failing/affected tasks (default: 1). */
  failedTaskCount?: number;
  /** Distinct repository file paths already known to be involved. */
  mentionedFiles?: string[];
  /** Currently available (installed + in-quota) agent ids, e.g. ['claude', 'codex', 'agy']. */
  availableAgents: string[];
  /** Explicit agent the user named — always honored when available. */
  explicitAgentId?: string;
}

export interface ProblemAgentRecommendation {
  size: ProblemSize;
  /** Ordered agent ids best suited for this problem size (primary first). */
  recommendedAgents: string[];
  /** Primary chosen agent id (undefined only when availableAgents is empty). */
  primaryAgent?: string;
  /** True when the problem is large enough to benefit from multiple agents. */
  recommendMultiAgent: boolean;
  /** Concise human-readable rationale for why this agent/strategy was chosen. */
  reason: string;
  signals: {
    distinctFiles: number;
    failedTasks: number;
    hasArchitecturalSignals: boolean;
    hasLocalizedTestOrSyntaxSignals: boolean;
  };
}

const FILE_PATH_RE =
  /\b(?:[\w./-]+\/)?[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|java|kt|rb|php|cs|cpp|c|h|yaml|yml|json|toml|sql|sh)\b/gi;

const ARCHITECTURAL_RE =
  /\b(?:architectur\w*|arquitetur\w*|refactor\w*|refator\w*|migrat\w*|migra[cç]\w*|schema|security|seguran[cç]a|auth(?:entication|orization)?|autentica[cç][aã]o|concurren\w*|concorr[eê]ncia|race\s+condition|deadlock|distributed|cross-?module|cross-?cutting|multi-?service|protocolo?|pipeline|database|banco\s+de\s+dados|redesign|rewrite|reescrev\w*)\b/i;

const LOCALIZED_FIX_RE =
  /\b(?:filenotfounderror|syntaxerror|typeerror|importerror|modulenotfounderror|assertionerror|nameerror|attributeerror|referenceerror|ts\d{4}|eslint|pytest|vitest|test_[\w]+\.py|[\w.-]+\.test\.[tj]sx?|exit\s+code|typo|lint|fixture|mock|import)\b/i;

const ERROR_LINE_RE = /\b(?:ERROR|FAILED|Traceback|AssertionError|FileNotFoundError)\b/;

function pickOrdered(preference: string[], available: string[]): string[] {
  const availSet = new Set(available);
  const picked = preference.filter((id) => availSet.has(id));
  for (const id of available) {
    if (!picked.includes(id)) picked.push(id);
  }
  return picked;
}

/**
 * Assesses the size/complexity of a failure or task and picks the best available
 * coding agent(s) automatically, while always respecting an explicit user choice.
 *
 * - small (1–2 files, localized test/config/syntax failure): prefers fast surgical
 *   fixer (`codex` → `claude` → `agy`), single agent.
 * - medium (3–5 files, multiple tasks, or architectural/cross-module signals):
 *   prefers deeper cross-file reasoning (`claude` → `agy` → `codex`).
 * - large (6+ files, 3+ failing tasks, or broad architectural scope): prefers
 *   deep reasoning primary (`claude` → `agy` → `codex`) and flags multi-agent.
 */
export function assessProblemAndSelectAgent(
  input: ProblemAssessmentInput,
): ProblemAgentRecommendation {
  const text = input.text ?? '';
  const available = [...new Set(input.availableAgents.filter(Boolean))];

  const files = new Set<string>(
    (input.mentionedFiles ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean),
  );
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const candidate = match[0].toLowerCase();
    // Ignore version-like strings such as "v1.0.ts" isn't common, but keep real filenames
    if (!candidate.startsWith('http')) {
      files.add(candidate);
    }
  }

  const distinctFiles = files.size;
  const failedTasks = Math.max(1, input.failedTaskCount ?? 1);
  const hasArchitecturalSignals = ARCHITECTURAL_RE.test(text);
  const hasLocalizedTestOrSyntaxSignals = LOCALIZED_FIX_RE.test(text);
  const uniqueErrorLines = new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && ERROR_LINE_RE.test(l)),
  ).size;

  let size: ProblemSize = 'small';
  if (
    failedTasks >= 3 ||
    distinctFiles >= 6 ||
    (hasArchitecturalSignals && distinctFiles >= 3)
  ) {
    size = 'large';
  } else if (
    failedTasks >= 2 ||
    distinctFiles >= 3 ||
    hasArchitecturalSignals ||
    (uniqueErrorLines >= 5 && distinctFiles >= 3)
  ) {
    size = 'medium';
  }

  const signals = {
    distinctFiles,
    failedTasks,
    hasArchitecturalSignals,
    hasLocalizedTestOrSyntaxSignals,
  };

  if (input.explicitAgentId && available.includes(input.explicitAgentId)) {
    const ordered = pickOrdered([input.explicitAgentId], available);
    return {
      size,
      recommendedAgents: ordered,
      primaryAgent: input.explicitAgentId,
      recommendMultiAgent: size === 'large' && available.length >= 2,
      reason: `explicitly requested by user (${size} problem)`,
      signals,
    };
  }

  if (available.length === 0) {
    return {
      size,
      recommendedAgents: [],
      primaryAgent: undefined,
      recommendMultiAgent: false,
      reason: 'no available agents detected',
      signals,
    };
  }

  if (size === 'small') {
    const ordered = pickOrdered(['codex', 'claude', 'agy'], available);
    const scopeHint =
      distinctFiles > 0
        ? `${distinctFiles} file${distinctFiles === 1 ? '' : 's'}`
        : hasLocalizedTestOrSyntaxSignals
          ? 'localized test/script failure'
          : 'localized scope';
    return {
      size,
      recommendedAgents: ordered,
      primaryAgent: ordered[0],
      recommendMultiAgent: false,
      reason: `small problem (${scopeHint}) — fast single-agent fix`,
      signals,
    };
  }

  if (size === 'medium') {
    const ordered = pickOrdered(['claude', 'agy', 'codex'], available);
    const scopeHint = hasArchitecturalSignals
      ? 'cross-module/architectural scope'
      : `${distinctFiles} files / ${failedTasks} task${failedTasks === 1 ? '' : 's'}`;
    return {
      size,
      recommendedAgents: ordered,
      primaryAgent: ordered[0],
      recommendMultiAgent: false,
      reason: `medium problem (${scopeHint}) — deeper multi-file reasoning`,
      signals,
    };
  }

  const ordered = pickOrdered(['claude', 'agy', 'codex'], available);
  return {
    size: 'large',
    recommendedAgents: ordered,
    primaryAgent: ordered[0],
    recommendMultiAgent: available.length >= 2,
    reason: `large problem (${distinctFiles} file${distinctFiles === 1 ? '' : 's'}, ${failedTasks} task${failedTasks === 1 ? '' : 's'}) — deep reasoning${available.length >= 2 ? ' + multi-agent recommended' : ''}`,
    signals,
  };
}
