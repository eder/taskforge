/**
 * The user's execution intent is a first-class constraint on the whole run,
 * determined once from the raw goal text before planning happens. It is
 * authoritative: neither the planner, the router, the agent selector, nor an
 * agent's own behavior may relax it once determined.
 */
export type ExecutionIntent =
  | 'READ_ONLY_ANALYSIS'
  | 'IMPLEMENTATION'
  | 'INVESTIGATION'
  | 'REVIEW'
  | 'MIXED';

export interface ExecutionIntentDecision {
  intent: ExecutionIntent;
  mutationAllowed: boolean;
  deliveryAllowed: boolean;
  allowedScope: string[];
  forbiddenChanges: string[];
  reason: string;
}

/**
 * These patterns mean "do not mutate the repository at all". They are
 * intentionally narrower than a generic "do not modify X" match: a scoped
 * constraint such as "implement /health, but do not modify the Delivery Gate"
 * must remain an implementation request rather than turning the whole run into
 * READ_ONLY_ANALYSIS.
 */
const GLOBAL_NO_MUTATION_PATTERNS: RegExp[] = [
  /\b(?:do\s*not|don'?t)\s+(?:modify|change|edit|alter|write|create|implement|delete|remove|touch|update)\s+(?:anything|the\s+(?:repository|repo)|(?:any|all)\s+(?:files?|code))\b/i,
  // Bare repository-wide targets such as "do not create files" and "do not
  // write code" are also global mutation bans. Keep these concrete so phrases
  // like "do not create a hardcoded integration" remain architectural guidance.
  /\b(?:do\s*not|don'?t)\s+(?:create|write|modify|change|edit|alter|delete|remove|touch|update)\s+(?:files?|code)\b/i,
  /\bn[ãa]o\s+(?:crie|escreva|altere|modifique|edite|apague|delete|remova|toque|atualize)\s+(?:arquivos?|c[oó]digo)\b/i,
  /\b(?:make|perform)\s+no\s+(?:changes?|modifications?)\b/i,
  /\bno\s+(?:repository|repo|code|file)\s+changes?\b/i,
  /\bn[ãa]o\s+(?:altere|modifique|implemente|crie|edite|escreva|apague|delete|remova|toque|atualize)\s+(?:nada|o\s+reposit[oó]rio|reposit[oó]rio|nenhum(?:a)?\s+(?:arquivo|c[oó]digo))\b/i,
  /\bsem\s+(?:alterar|modificar|editar|escrever|criar|remover)\s+(?:nada|arquivos?|o\s+reposit[oó]rio|reposit[oó]rio)\b/i,
];

// Explicit "this is read-only / analysis-only" phrases.
const EXPLICIT_READ_ONLY_PATTERNS: RegExp[] = [
  /\b(?:analysis\s*only|read[\s-]?only|read\s+only\s+evaluation)\b/i,
  /\bsomente\s+an[áa]lise\b/i,
  /\bapenas\s+an[áa]lise\b/i,
  /\ban[áa]lise\s+(?:somente|apenas)\b/i,
];

// Same action-verb detection the planner uses to decide whether a goal is
// "pure explanation" -- kept independent (not imported from @taskforge/planner)
// since @taskforge/shared must not depend on higher-level packages.
const ACTION_VERB_PATTERN =
  /\b(create|build|implement|add|make|fix|repair|patch|refactor|remove|delete|update|write|edit|modify|crie|criar|implemente|adicione|corrija|corrigir|modifique|atualize|remova)\b/i;

const EXPLANATION_PATTERN =
  /\b(explain|analyze|analyse|evaluate|assess|review|opinion|what do you think|recommend|investigate|understand|summari[sz]e|summary|overview|describe|tell me about|avalie|analise|explique|opini[ãa]o|investigue|entenda|resuma|resumir|resumo|descreva|vis[aã]o geral)\b/i;

/**
 * Clause terminators deliberately treat "." as punctuation only when it is
 * followed by whitespace/end. That keeps file names such as package.json or
 * README.md intact.
 */
const SCOPED_NO_MUTATION_PATTERNS: RegExp[] = [
  // Scoped repository restrictions must be explicit edit prohibitions.
  // Deliberately exclude "implement/create/write" and subordinate "without
  // changing..." phrasing: those commonly describe architectural outcomes
  // rather than files/components the current run is forbidden to touch.
  /\b(?:do\s*not|don'?t)\s+(?:modify|change|edit|alter|delete|remove|touch|update)\s+(.+?)(?=\s+(?:but|however)\s+|\s+and\s+(?=(?:create|build|implement|add|make|fix|repair|patch|refactor|remove|delete|update|write|edit|modify)\b)|[!?;]|\.(?=\s|$)|\n|$)/gi,
  /\bn[ãa]o\s+(?:altere|modifique|edite|apague|delete|remova|toque|atualize)\s+(.+?)(?=\s+(?:mas|por[eé]m)\s+|\s+e\s+(?=(?:crie|criar|implemente|adicione|corrija|corrigir|modifique|atualize|remova)\b)|[!?;]|\.(?=\s|$)|\n|$)/gi,
];

const NEGATED_MUTATION_CLAUSE_PATTERNS: RegExp[] = [
  /\b(?:do\s*not|don'?t)\s+(?:modify|change|edit|alter|write|create|implement|delete|remove|touch|update)\b.+?(?=\s+(?:but|however)\s+|\s+and\s+(?=(?:create|build|implement|add|make|fix|repair|patch|refactor|remove|delete|update|write|edit|modify)\b)|[!?;]|\.(?=\s|$)|\n|$)/gi,
  /\bn[ãa]o\s+(?:altere|modifique|implemente|crie|edite|escreva|apague|delete|remova|toque|atualize)\b.+?(?=\s+(?:mas|por[eé]m)\s+|\s+e\s+(?=(?:crie|criar|implemente|adicione|corrija|corrigir|modifique|atualize|remova)\b)|[!?;]|\.(?=\s|$)|\n|$)/gi,
  /\bsem\s+(?:alterar|modificar|editar|escrever|criar|remover)\b.+?(?=\s+(?:mas|por[eé]m)\s+|\s+e\s+(?=(?:crie|criar|implemente|adicione|corrija|corrigir|modifique|atualize|remova)\b)|[!?;]|\.(?=\s|$)|\n|$)/gi,
];

function hasGlobalNoMutationDirective(text: string): boolean {
  return GLOBAL_NO_MUTATION_PATTERNS.some((p) => p.test(text));
}

function hasExplicitReadOnlyPhrase(text: string): boolean {
  return EXPLICIT_READ_ONLY_PATTERNS.some((p) => p.test(text));
}

function stripNegatedMutationClauses(text: string): string {
  return NEGATED_MUTATION_CLAUSE_PATTERNS.reduce(
    (remaining, pattern) => remaining.replace(pattern, ' '),
    text,
  );
}

function normalizeRestrictionTarget(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/^(?:the|o|a|os|as)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return undefined;

  // Whole-repository restrictions are represented by the authoritative
  // wildcard rather than a human-readable scoped target.
  if (
    /^(?:anything|everything|any\s+files?|all\s+files?|the\s+repository|repository|repo|nada|nenhum(?:a)?\s+arquivo|arquivos?|reposit[oó]rio)$/i.test(
      cleaned,
    )
  ) {
    return undefined;
  }

  return cleaned;
}

function extractScopedNoMutationTargets(text: string): string[] {
  const targets = new Set<string>();

  for (const pattern of SCOPED_NO_MUTATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const target = normalizeRestrictionTarget(match[1] ?? '');
      if (target) targets.add(target);
    }
  }

  return [...targets];
}

export function isLightweightReadOnlyRequest(text: string): boolean {
  const positiveText = stripNegatedMutationClauses(text ?? '');
  if (ACTION_VERB_PATTERN.test(positiveText)) return false;

  return (
    EXPLANATION_PATTERN.test(text ?? '') ||
    /\b(?:what (?:is|does)|how does|como funciona|o que (?:faz|é))\b/i.test(text ?? '')
  );
}

function isExplanationOnlyHeuristic(text: string): boolean {
  return isLightweightReadOnlyRequest(text);
}

/**
 * Determines the execution intent for an entire run from the user's raw goal
 * text, before any planning happens.
 *
 * Important distinction:
 * - "Do not modify anything" is a GLOBAL read-only directive.
 * - "Implement X, but do not modify Y" is IMPLEMENTATION with Y propagated
 *   as a scoped forbidden change.
 * - Architectural outcome language such as "support providers without changing
 *   Planner/Router" is not promoted into forbiddenChanges automatically.
 *
 * This prevents a normal engineering constraint from disabling the entire run.
 */
export function detectExecutionIntent(goalDescription: string): ExecutionIntentDecision {
  const text = goalDescription ?? '';

  if (hasGlobalNoMutationDirective(text)) {
    return {
      intent: 'READ_ONLY_ANALYSIS',
      mutationAllowed: false,
      deliveryAllowed: false,
      allowedScope: [],
      forbiddenChanges: ['*'],
      reason: 'Goal text explicitly forbids repository mutation for the whole run.',
    };
  }

  if (hasExplicitReadOnlyPhrase(text)) {
    return {
      intent: 'READ_ONLY_ANALYSIS',
      mutationAllowed: false,
      deliveryAllowed: false,
      allowedScope: [],
      forbiddenChanges: ['*'],
      reason: 'Goal text explicitly requests a read-only / analysis-only evaluation.',
    };
  }

  const scopedRestrictions = extractScopedNoMutationTargets(text);
  const positiveMutationText = stripNegatedMutationClauses(text);
  const hasPositiveMutationRequest = ACTION_VERB_PATTERN.test(positiveMutationText);

  if (
    isExplanationOnlyHeuristic(text) ||
    (!hasPositiveMutationRequest && scopedRestrictions.length > 0)
  ) {
    return {
      intent: 'READ_ONLY_ANALYSIS',
      mutationAllowed: false,
      deliveryAllowed: false,
      allowedScope: [],
      forbiddenChanges: ['*'],
      reason:
        'Goal text requests analysis/explanation without an affirmative repository mutation request.',
    };
  }

  return {
    intent: 'IMPLEMENTATION',
    mutationAllowed: true,
    deliveryAllowed: true,
    allowedScope: ['*'],
    forbiddenChanges: scopedRestrictions,
    reason:
      scopedRestrictions.length > 0
        ? `Goal requests implementation with scoped no-modification constraints: ${scopedRestrictions.join(', ')}.`
        : 'Goal text contains or implies implementation work.',
  };
}
