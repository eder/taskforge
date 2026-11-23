import { detectExecutionIntent } from '@taskforge/shared';
import { assessProblemAndSelectAgent, type ProblemSize } from './problem-size-router.js';
import { extractOrchestratedAgentPreferences } from './direct-agent-router.js';

export interface AutoDispatchInput {
  text: string;
  availableAgents: string[];
  mentionedFiles?: string[];
  hasPriorContext?: boolean;
}

export interface AutoDispatchDecision {
  mode: 'direct' | 'orchestrated';
  targetAgentId?: string;
  size: ProblemSize;
  mutationAllowed: boolean;
  reason: string;
}

const EXPLICIT_ORCHESTRATION_RE =
  /\b(?:cria(?:r)?\s+(?:um\s+)?plano|faz(?:er)?\s+(?:um\s+)?plano|planeja(?:r)?|create\s+a\s+plan|make\s+a\s+plan|orchestrat\w*|orquestra\w*|worktree|pull\s+request|\bpr\b|constru[ií](?:r)?\s+(?:um|uma)\s+(?:sistema|app|aplica[çc][aã]o|plataforma|projeto)|build\s+(?:a|an)\s+(?:full|complete|new|entire)\s+(?:system|app|application|platform|project)|sistema\s+(?:completo|de\s+))\b/i;

const BROAD_ANALYSIS_RE =
  /\b(?:o\s+que\s+(?:ainda\s+)?falta\s+fazer|auditoria\s+completa|full\s+audit|reposit[óo]rio\s+inteiro|projeto\s+inteiro|whole\s+(?:repo|repository|project|codebase)|entire\s+(?:repo|repository|project|codebase)|roadmap|pend[eê]ncias\s+do\s+projeto|an[áa]lise\s+completa|deep\s+audit)\b/i;

const FEATURE_OR_BROAD_MUTATION_RE =
  /\b(?:implement\w*|cria(?:r)?\s+(?:um|uma|o|a)\s+(?:novo|nova|endpoint|servi[çc]o|m[óo]dulo|sistema|tela|componente|api|feature|dashboard|integra[çc][aã]o)|create\s+(?:a\s+)?(?:new\s+)?(?:endpoint|service|module|system|screen|component|api|feature|dashboard|integration)|integrat\w*|integra[çc][aã]o|migrat\w*|migra[çc][aã]o|add\s+(?:full|oauth|auth|authentication|support\s+for))\b/i;

const LOCALIZED_EDIT_RE =
  /\b(?:typo|ortograf\w*|renome\w*|rename|coment[áa]rio|comment|docstring|log\b|print\b|format\w*|lint|import|ajust\w*|tweak|pequen\w*|small\s+fix|quick\s+fix|corrig(?:e|ir)\s+(?:o\s+)?(?:erro|bug|typo|lint|tipo|type)|fix\s+(?:the\s+)?(?:typo|lint|import|error|bug\s+in))\b/i;

const READ_ONLY_QUESTION_RE =
  /^(?:o\s+que|como|onde|qual|quais|por\s+que|explic[ae]\w*|mostr[ae]\w*|resum[ae]\w*|what|how|where|which|why|explain|show|describe|summarize|tell\s+me)\b/i;

const EXPLICIT_MUTATION_VERB_RE =
  /\b(?:altera\w*|muda\w*|edita\w*|edit\b|modify|change|corrig\w*|fix\b|cria\w*|create|add\b|adicion\w*|remov\w*|delet\w*|apag\w*|implement\w*|refator\w*|refactor|renome\w*|rename|update|atualiz\w*|write|escrev\w*)\b/i;

/**
 * Decides in `auto` mode whether a plain user message should go straight to a
 * fast Direct Mode turn (native resumed session, 0 graph/worktree ceremony) or
 * scale up to the full Orchestrated Multi-Agent Pipeline (parallel worktrees,
 * verification, Delivery Gate).
 */
export function decideAutoDispatch(input: AutoDispatchInput): AutoDispatchDecision {
  const text = input.text.trim();
  const intent = detectExecutionIntent(text);
  const looksLikePureQuestion =
    (text.endsWith('?') || READ_ONLY_QUESTION_RE.test(text)) &&
    !EXPLICIT_MUTATION_VERB_RE.test(text);
  const mutationAllowed = intent.mutationAllowed && !looksLikePureQuestion;
  const prefs = extractOrchestratedAgentPreferences(text);
  const explicitAgentId =
    prefs.implementer && !prefs.reviewer
      ? prefs.implementer
      : prefs.defaultAgent && !prefs.reviewer
        ? prefs.defaultAgent
        : undefined;

  const assessment = assessProblemAndSelectAgent({
    text,
    mentionedFiles: input.mentionedFiles,
    availableAgents: input.availableAgents,
    explicitAgentId,
  });

  if (input.availableAgents.length === 0 || !assessment.primaryAgent) {
    return {
      mode: 'orchestrated',
      size: assessment.size,
      mutationAllowed,
      reason: 'no ready agents for fast direct dispatch',
    };
  }

  // Multi-role directives ("claude implementa e codex revisa") always belong in orchestration.
  if (prefs.implementer && prefs.reviewer && prefs.implementer !== prefs.reviewer) {
    return {
      mode: 'orchestrated',
      size: assessment.size,
      mutationAllowed,
      reason: `multi-role workflow (${prefs.implementer} + ${prefs.reviewer})`,
    };
  }

  // Explicit plan / full-system / delivery cues stay orchestrated.
  if (EXPLICIT_ORCHESTRATION_RE.test(text)) {
    return {
      mode: 'orchestrated',
      size: assessment.size,
      mutationAllowed,
      reason: 'explicit plan/system/delivery workflow requested',
    };
  }

  // Follow-ups referencing an earlier orchestrated run stay orchestrated so priorContext attaches cleanly.
  if (input.hasPriorContext) {
    return {
      mode: 'orchestrated',
      size: assessment.size,
      mutationAllowed,
      reason: 'depends on prior orchestrated run context',
    };
  }

  // Broad project-wide read-only audits benefit from parallel multi-agent orchestration.
  if (!mutationAllowed && BROAD_ANALYSIS_RE.test(text)) {
    return {
      mode: 'orchestrated',
      size: assessment.size,
      mutationAllowed: false,
      reason: 'project-wide analysis suited for parallel multi-agent run',
    };
  }

  // Medium or large problems scale automatically to orchestrated multi-agent execution.
  if (assessment.size !== 'small') {
    return {
      mode: 'orchestrated',
      size: assessment.size,
      mutationAllowed,
      reason: assessment.reason,
    };
  }

  // Focused read-only question / code inspection -> instant Direct Mode turn!
  if (!mutationAllowed && text.length <= 280) {
    return {
      mode: 'direct',
      targetAgentId: assessment.primaryAgent,
      size: 'small',
      mutationAllowed: false,
      reason: `focused read-only question (${assessment.reason})`,
    };
  }

  // Small localized single-file edit (explicitly targets 1-2 files or tiny fix, not a new feature) -> Direct Mode!
  if (
    mutationAllowed &&
    text.length <= 240 &&
    !FEATURE_OR_BROAD_MUTATION_RE.test(text) &&
    (assessment.signals.distinctFiles >= 1 || LOCALIZED_EDIT_RE.test(text))
  ) {
    return {
      mode: 'direct',
      targetAgentId: assessment.primaryAgent,
      size: 'small',
      mutationAllowed: true,
      reason: `localized small edit (${assessment.reason})`,
    };
  }

  return {
    mode: 'orchestrated',
    size: assessment.size,
    mutationAllowed,
    reason: 'multi-step implementation suited for isolated worktrees & verification',
  };
}
