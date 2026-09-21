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

// Explicit "do not <mutate>" directives, in either language. Presence
// anywhere in the goal text wins over any other keyword heuristic -- an
// explicit instruction not to touch the repository is a stronger signal than
// any incidental mention of an action-sounding word elsewhere in the text.
const NO_MUTATION_DIRECTIVE_PATTERNS: RegExp[] = [
  /\b(?:do\s*not|don'?t)\s+(?:modify|change|edit|alter|write|create|implement|delete|remove|touch|update)\b/i,
  /\bn[ãa]o\s+(?:altere|modifique|implemente|crie|edite|escreva|apague|delete|remova|toque|atualize)\b/i,
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
  /\b(explain|analyze|analyse|evaluate|assess|review|opinion|what do you think|recommend|investigate|understand|avalie|analise|explique|opini[ãa]o|investigue|entenda)\b/i;

function hasExplicitNoMutationDirective(text: string): boolean {
  return NO_MUTATION_DIRECTIVE_PATTERNS.some((p) => p.test(text));
}

function hasExplicitReadOnlyPhrase(text: string): boolean {
  return EXPLICIT_READ_ONLY_PATTERNS.some((p) => p.test(text));
}

function isExplanationOnlyHeuristic(text: string): boolean {
  return !ACTION_VERB_PATTERN.test(text) && EXPLANATION_PATTERN.test(text);
}

/**
 * Determines the execution intent for an entire run from the user's raw goal
 * text, before any planning happens. This is the first of two barriers (see
 * the Intent Guard, applied after planning) that keep READ_ONLY_ANALYSIS
 * requests from silently becoming implementation work.
 */
export function detectExecutionIntent(goalDescription: string): ExecutionIntentDecision {
  const text = goalDescription ?? '';

  if (hasExplicitNoMutationDirective(text)) {
    return {
      intent: 'READ_ONLY_ANALYSIS',
      mutationAllowed: false,
      deliveryAllowed: false,
      allowedScope: [],
      forbiddenChanges: ['*'],
      reason: 'Goal text contains an explicit instruction not to modify the repository.',
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

  if (isExplanationOnlyHeuristic(text)) {
    return {
      intent: 'READ_ONLY_ANALYSIS',
      mutationAllowed: false,
      deliveryAllowed: false,
      allowedScope: [],
      forbiddenChanges: ['*'],
      reason: 'Goal text has no mutating action verb and reads as an explanation/analysis request.',
    };
  }

  return {
    intent: 'IMPLEMENTATION',
    mutationAllowed: true,
    deliveryAllowed: true,
    allowedScope: ['*'],
    forbiddenChanges: [],
    reason: 'Goal text contains a mutating action verb; treated as normal implementation work.',
  };
}
