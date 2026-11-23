import type { RunFocus } from './run-focus.js';

export interface NaturalRunRequest {
  /** 'continue' = resume/retry/fix a run; 'inspect' = ask why a run stopped / what happened; 'none' = regular goal */
  kind: 'continue' | 'inspect' | 'none';
  /** True when the message ONLY asks to continue/resume (no additional coding/recovery instruction). */
  bare: boolean;
  /** Explicit run-... identifier mentioned in the message, if any. */
  explicitRunId?: string;
  /** Extra instruction beyond continuing the run (e.g. "pulando o preflight" or "corrigindo o teste"). */
  guidance?: string;
  /** Detected language for conversational responses. */
  language: 'pt' | 'en';
}

const EXPLICIT_RUN_ID_RE = /\brun-\d{10,}\b/i;

function detectPtOrEn(text: string): 'pt' | 'en' {
  const lower = text.toLowerCase();
  return /\b(?:voc[eê]|vc|[uú]ltima|essa|esta|aquela|quero|continua(?:r)?|retom[ae](?:r)?|falhou|parou|onde|tenta(?:r)?|por\s*que|pq|o\s+que|qual|pra|para|de\s+novo|novamente|arrum[ae](?:r)?|corrig[ei](?:r)?|aconteceu|execu[cç][aã]o|hist[oó]rico)\b/i.test(
    lower,
  )
    ? 'pt'
    : 'en';
}

/**
 * Recognizes natural-language requests (PT and EN) at the idle REPL prompt to
 * continue/resume/retry or inspect a run without requiring `/retry` or `/inspect`.
 * Carefully avoids false positives on normal goals like
 * "Eu preciso entender onde paramos no projeto para continuar" or
 * "implement item 1 from run-1790000000000006 with tests".
 */
export function parseNaturalRunRequest(rawText: string): NaturalRunRequest {
  const text = rawText.trim();
  const language = detectPtOrEn(text);
  if (!text || text.includes('\n')) {
    return { kind: 'none', bare: false, language };
  }

  const explicitRunId = EXPLICIT_RUN_ID_RE.exec(text)?.[0].toLowerCase();
  const lower = text.toLowerCase();
  const mentionsRunTarget =
    Boolean(explicitRunId) ||
    /\b(?:(?:a|essa|esta|aquela|the|this|that|my)\s+)?(?:[uú]ltima|ultima|anterior|passada|last|previous|recent|failed|stopped|broken|interrupted)\s+(?:run|execu[cç][aã]o)\b/i.test(
      lower,
    ) ||
    /\b(?:a|essa|esta|aquela|the|this|that)\s+(?:run|execu[cç][aã]o)\s+(?:que\s+(?:falhou|parou|travou|deu\s+erro)|that\s+(?:failed|stopped))\b/i.test(
      lower,
    ) ||
    /\b(?:de\s+onde\s+parou|from\s+where\s+(?:it|we)\s+(?:stopped|left\s+off))\b/i.test(lower);

  if (!mentionsRunTarget) {
    return { kind: 'none', bare: false, language };
  }

  // 1. Asking why a run failed / what happened in a run (no `/inspect` needed).
  const hasMutationIntent =
    /\b(?:implement\w*|cria(?:r)?|create|add|adicion\w*|fa[cç]a|faz(?:er)?|corrig\w*|arrum\w*|fix(?:es|ed|ing)?|alter\w*|edit\w*|open\s+(?:a\s+)?pr|abr[aei]\s+(?:um\s+)?pr)\b/i.test(
      lower,
    );
  const asksInspectRun =
    !hasMutationIntent &&
    (/\b(?:por\s*que|pq|porque|o\s+que\s+(?:aconteceu|deu\s+errado|falhou|houve|travou|bloqueou)|qual\s+(?:foi\s+)?o\s+erro|como\s+(?:ficou|terminou|foi)|me\s+explica|explica)\b/i.test(
      lower,
    ) ||
      /\b(?:why\s+did|what\s+(?:happened|went\s+wrong|failed|stopped|blocked)|how\s+did|explain|inspect|status\s+of)\b/i.test(
        lower,
      ));
  if (asksInspectRun) {
    return { kind: 'inspect', bare: true, explicitRunId, language };
  }

  // 2. Guard against analysis/read-only goals that merely end with "para continuar" / "to continue"
  //    (e.g. "Eu preciso entender onde paramos no projeto para continuar").
  const startsWithAnalysisVerb =
    /^(?:(?:eu\s+)?(?:preciso|quero|gostaria\s+de|queria)\s+)?(?:entender|saber|ver|analisar|descobrir|understand|know|see|analyze|find\s+out)\b/i.test(
      lower,
    );
  if (startsWithAnalysisVerb) {
    return { kind: 'none', bare: false, explicitRunId, language };
  }

  // 3. Natural-language continue / resume / retry / fix-and-continue of a run.
  //    Must be a lead/imperative action targeting the run, not a subordinate "para continuar".
  const leadContinuePattern =
    /^(?:(?:por\s+favor|please|oi|ol[aá]|hey)\s*,?\s*)?(?:(?:eu\s+)?(?:quero|queria|gostaria)\s+(?:que\s+(?:vc|voc[eê])\s+|de\s+)?|(?:vc|voc[eê])\s+pode\s+|pode\s+|vamos\s+|let'?s\s+|can\s+you\s+|could\s+you\s+|i\s+want\s+(?:you\s+)?to\s+|please\s+)?(?:(?:arrum[ae](?:r)?|corrig[ei](?:r)?|consert[ae](?:r)?|resolv[ae](?:r)?|fix|repair)\s+(?:e|and)\s+)?(?:continu(?:e|a|ar)|retom(?:e|a|ar)|tent(?:e|a|ar)\s+(?:de\s+novo|novamente)|rod(?:e|a|ar)\s+(?:de\s+novo|novamente)|reexecut(?:e|a|ar)|refa(?:[cç]a|zer)|destrav(?:e|a|ar)|resume|retry|re-?run|continue|pick\s+up|finish|try\s+again)\b/i;

  if (!leadContinuePattern.test(text)) {
    return { kind: 'none', bare: false, explicitRunId, language };
  }

  // Strip the continue boilerplate + run reference to see if any concrete guidance remains.
  let remainder = text
    .replace(leadContinuePattern, '')
    .replace(EXPLICIT_RUN_ID_RE, '')
    .replace(
      /\b(?:com\s+)?(?:a|o|essa|esta|aquela|the|this|that|my)?\s*(?:[uú]ltima|ultima|anterior|passada|last|previous|recent|failed|stopped|broken|interrupted)?\s*(?:run|execu[cç][aã]o)\b/gi,
      '',
    )
    .replace(/\b(?:que\s+(?:falhou|parou|travou|deu\s+erro)|that\s+(?:failed|stopped))\b/gi, '')
    .replace(/\b(?:de\s+onde\s+parou|onde\s+parou|from\s+where\s+(?:it|we)\s+(?:stopped|left\s+off))\b/gi, '')
    .replace(/\b(?:por\s+favor|please|pra\s+mim|para\s+mim|for\s+me|agora|now|de\s+novo|novamente|again|aqui|here)\b/gi, '')
    .replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '')
    .replace(/^(?:mas|e|com|and|but|with)\s+/i, '')
    .trim();

  if (remainder.length < 4) {
    remainder = '';
  }

  return {
    kind: 'continue',
    bare: remainder.length === 0,
    explicitRunId,
    guidance: remainder || undefined,
    language,
  };
}

export type FocusedInstructionResolution =
  | { kind: 'accept_proposal' }
  | { kind: 'retry_now' }
  | { kind: 'explain'; language: 'pt' | 'en' }
  | { kind: 'leave' }
  | { kind: 'skip_preflight'; guidance?: string }
  | { kind: 'set_check_command'; command: string }
  | { kind: 'run_shell_command'; command: string }
  | { kind: 'investigate_with_agent'; question: string }
  | { kind: 'fix_with_agent'; guidance: string }
  | { kind: 'continue_with_guidance'; guidance: string };

const SHELL_COMMAND_PREFIX =
  /^(?:docker(?:\s+compose)?|docker-compose|pytest|python3?|uv|poetry|pnpm|npm|yarn|bun|make|cargo|go\s+(?:test|build|run|mod|vet)|brew|systemctl|uvicorn|gunicorn|sh|bash)\b/i;

function extractBacktickCommand(text: string): string | undefined {
  const match = /`([^`\n]+)`/.exec(text);
  return match?.[1]?.trim() || undefined;
}

/**
 * Classifies an open-text user message while the REPL is focused on a stopped
 * run (PT and EN). Lets the user resolve environment, preflight, check-command,
 * or test/code inconsistencies conversationally instead of getting trapped in
 * `/retry` loops.
 */
export function classifyFocusedInstruction(
  rawText: string,
  focus: RunFocus,
): FocusedInstructionResolution {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // 1. Explicit leave / cancel in PT or EN.
  if (
    /^(?:n[aã]o|cancela(?:r)?|deixa\s+pra\s+l[aá]|esquece|deixa|para|cancel|nevermind|never\s+mind|abort|leave|stop)[.!?\s]*$/i.test(
      lower,
    )
  ) {
    return { kind: 'leave' };
  }

  // 1b. Questions asking why it failed / what happened (never pass as agent guidance!).
  const asksExplainPt =
    /^(?:por\s*que|pq|porque)\b[^.\n]{0,80}(?:falh|erro|parou|bloque|n[aã]o\s+(?:rodou|passou|funcionou|foi)|aconteceu)/i.test(
      lower,
    ) ||
    /^(?:o\s+que\s+(?:aconteceu|deu\s+errado|falhou|houve)|qual\s+(?:foi\s+)?o\s+erro|me\s+explica|explica(?:\s+isso|\s+esse\s+erro|\s+melhor)?|n[aã]o\s+entendi(?:\s+nada|\s+esse\s+erro|\s+o\s+erro)?)[.!?\s]*$/i.test(
      lower,
    );
  if (asksExplainPt) {
    return { kind: 'explain', language: 'pt' };
  }
  const asksExplainEn =
    /^(?:why\s+(?:did\s+(?:it|this|that)\s+)?(?:fail|stop|block|error)|what\s+(?:happened|went\s+wrong|failed|is\s+(?:this|the)\s+error)|explain(?:\s+(?:this|that|the\s+error|why))?|i\s+don'?t\s+understand)[.!?\s]*$/i.test(
      lower,
    );
  if (asksExplainEn) {
    return { kind: 'explain', language: 'en' };
  }

  // 1c. Bare retry / re-run requests in PT or EN (retry immediately without
  //     asking for Enter again or passing "Tente de novo" as agent guidance).
  if (
    /^(?:tent[ae](?:r)?\s+(?:de\s+novo|novamente|outra\s+vez)|rod[ae](?:r)?\s+(?:de\s+novo|novamente)|execut[ae](?:r)?\s+(?:de\s+novo|novamente)|test[ae](?:r)?\s+(?:de\s+novo|novamente)|verific[ae](?:r)?\s+(?:de\s+novo|novamente)|try\s+again|retry|run\s+again|re-?run|check\s+again|test\s+again)[.!?\s]*$/i.test(
      lower,
    )
  ) {
    return { kind: 'retry_now' };
  }

  // 2. Explicit skip / bypass preflight (works even if a question is pending).
  if (
    /\b(?:pula(?:r)?|ignora(?:r)?|desativa(?:r)?|sem|skip|bypass|ignore|disable)\b[^.\n]{0,40}\bpreflight\b/i.test(
      lower,
    ) ||
    /\bpreflight\b[^.\n]{0,30}\b(?:off|false|desligad|ignora|pula|skip)\b/i.test(lower)
  ) {
    const hasExtraGuidance = text.length > 35;
    return {
      kind: 'skip_preflight',
      guidance: hasExtraGuidance ? text : focus.guidance,
    };
  }

  // 3. Explicit replacement check/test command (e.g. "usa o comando `pytest -q --ignore=...`").
  const wantsCheckCommand =
    /\b(?:comando\s+de\s+(?:teste|verifica[cç][aã]o|check)|check\s+command|test\s+command|troca(?:r)?\s+o\s+comando|muda(?:r)?\s+o\s+comando|use\s+(?:the\s+)?(?:check|test)\s+command|usa(?:r)?\s+(?:o\s+)?comando)\b/i.test(
      lower,
    );
  if (wantsCheckCommand) {
    const backtick = extractBacktickCommand(text);
    const afterColon =
      /(?:comando(?:\s+de\s+(?:teste|verifica[cç][aã]o|check))?|command)\s*(?:para|por|to|:|=)\s*(.+)$/i
        .exec(text)?.[1]
        ?.trim()
        ?.replace(/^['"`]|['"`]$/g, '');
    const command = backtick ?? afterColon;
    if (command && command.length >= 2) {
      return { kind: 'set_check_command', command };
    }
  }

  // 4. Explicit shell command request (e.g. "roda `docker compose up -d zaira`" or "executa docker compose up -d").
  const shellTrigger =
    /^(?:roda(?:r)?|executa(?:r)?|rode|execute|run|sobe\s+com|inicia\s+com|start\s+with)\s+(.+)$/i.exec(
      text,
    );
  if (shellTrigger) {
    const backtick = extractBacktickCommand(text);
    const candidate = (backtick ?? shellTrigger[1].trim()).replace(/^['"`]|['"`]$/g, '');
    if (backtick || SHELL_COMMAND_PREFIX.test(candidate)) {
      return { kind: 'run_shell_command', command: candidate };
    }
  }
  if (focus.action.kind === 'fix' && SHELL_COMMAND_PREFIX.test(text)) {
    return { kind: 'run_shell_command', command: text };
  }

  // 4b. Asking a real coding agent to investigate/diagnose the failure in read-only mode
  //     (e.g. "pede pro agente investigar esse erro", "analisa esse erro com o codex",
  //      "investigate this failure with an agent before editing").
  const withoutReadOnlyGuardClauses = lower.replace(
    /\b(?:antes\s+de|sem|n[aã]o\s+(?:quero\s+)?|before|without)\s+\w+(?:\s+\w+)?/gi,
    '',
  );
  const asksAgentToInvestigate =
    /\b(?:investig\w*|analis\w*|diagnostic\w*|analy[sz]\w*|diagnos\w*|inspect\w*)\b/i.test(lower) &&
    /\b(?:agente|agent|claude|codex|antigravity|agy|c[oó]digo|codebase|erro|falha|failure|error|causa|root\s+cause)\b/i.test(
      lower,
    ) &&
    !/\b(?:corrig\w*|arrum\w*|consert\w*|alter\w*|edit\w*|modific\w*|fix(?:es|ed|ing)?|patch(?:es|ed|ing)?)\b/i.test(
      withoutReadOnlyGuardClauses,
    );
  if (asksAgentToInvestigate) {
    return { kind: 'investigate_with_agent', question: text };
  }

  // 5. Asking the coding agent to fix the code/test/inconsistency itself
  //    (e.g. "corrige o test_multiturn.py para não depender da porta 8765",
  //     "resolve essa inconsistência no teste", "mocka a porta 8765").
  //    Must be checked BEFORE generic "resolve isso" acceptance so a concrete
  //    agent repair request does not merely re-run docker compose!
  const asksAgentToFixCodeOrTest =
    /\b(?:corrig\w*|arrum\w*|consert\w*|ajust\w*|resolv\w*|mock\w*|stub\w*|desabilit\w*|ignor\w*|pul\w*|remov\w*|isol\w*|fix(?:es|ed|ing)?|patch(?:es|ed|ing)?|repair(?:s|ed|ing)?|adjust(?:s|ed|ing)?|skip(?:s|ped|ping)?|ignore(?:s|d)?|isolate(?:s|d)?|disable(?:s|d)?|bypass(?:es|ed|ing)?)\b/i.test(
      lower,
    ) &&
    /\b(?:test(?:e|es|s)?|test_\w+|\.py\b|\.ts\b|\.js\b|inconsist[eê]ncia|inconsistency|c[oó]digo|code|porta\s+\d+|port\s+\d+|agente|agent|fixture|mock|suite|erro\s+do\s+teste|depend[eê]ncia|falha\s+no\s+teste)\b/i.test(
      lower,
    );
  if (asksAgentToFixCodeOrTest) {
    return { kind: 'fix_with_agent', guidance: text };
  }

  // 5b. Generic autonomous "fix whatever is needed and continue" when NO deterministic
  //     environment repair is proposed: hand off to the smart problem-size agent selector!
  if (
    focus.action.kind !== 'fix' &&
    !focus.pendingAction &&
    /^(?:fa[cç]a\s+os\s+ajustes|faz\s+os\s+ajustes|resolve\s+(?:isso|tudo|o\s+que\s+precisar)|corrig[ei]\s+(?:isso|tudo|o\s+que\s+precisar)|consert[ae]\s+(?:isso|tudo)|arrum[ae]\s+(?:isso|tudo)|fix\s+(?:this|it|whatever\s+is\s+needed)|make\s+the\s+necessary\s+adjustments|resolve\s+(?:this|the\s+error|the\s+issue))/i.test(
      lower,
    )
  ) {
    return { kind: 'fix_with_agent', guidance: text };
  }

  // 6. Natural-language acceptance of TaskForge's proposed action (PT or EN).
  //    Examples: "sim", "ok", "pode fazer", "pode subir", "sobe o zaira",
  //    "sobe o serviço e continua", "resolve isso pra mim", "conserta e continua",
  //    "bora", "manda ver", "go ahead", "do it", "fix it and continue", "start it".
  if (focus.action.kind !== 'none' || focus.pendingAction) {
    const naturalContinue = parseNaturalRunRequest(text);
    const shortAffirmation =
      /^(?:sim|s|ok|okay|beleza|blz|bora|manda\s+ver|vai|pode|claro|fechou|perfeito|confirmo|aprovo|concordo|yes|y|yep|yeah|sure|go\s+ahead|proceed|continue|do\s+it|fix\s+it|start\s+it|run\s+it|apply\s+it|go)[.!?\s]*$/i.test(
        lower,
      ) ||
      (naturalContinue.kind === 'continue' && naturalContinue.bare);
    const conversationalFixAccept =
      (focus.action.kind === 'fix' || Boolean(focus.pendingAction)) &&
      text.length <= 120 &&
      /^(?:pode\s+(?:fazer|subir|iniciar|rodar|consertar|corrigir|resolver|continuar|aplicar)|faz(?:er)?\s+isso|fa[cç]a\s+os\s+ajustes|faz\s+os\s+ajustes|sobe\s+(?:o\s+)?(?:servi[cç]o|container|docker|banco|\w+)|inicia\s+(?:o\s+)?(?:servi[cç]o|container|\w+)|resolve\s+(?:isso|o\s+que\s+precisar|tudo)|conserta\s+(?:isso|o\s+ambiente)|corrige\s+(?:isso|o\s+ambiente)|start\s+(?:the\s+)?service|fix\s+(?:this|it|the\s+environment|whatever\s+is\s+needed)|make\s+the\s+necessary\s+adjustments|please\s+(?:fix|start|do\s+that|go\s+ahead))/i.test(
        lower,
      );
    const conversationalBudgetAccept =
      focus.action.kind === 'raise_budget' &&
      text.length <= 100 &&
      /\b(?:aumenta|sobe|eleva|pode\s+aumentar|raise|increase|bump)\b.*\b(?:cap|limite|budget|tokens)\b/i.test(
        lower,
      );
    const conversationalCheckAccept =
      focus.action.kind === 'save_check_command' &&
      text.length <= 100 &&
      /\b(?:salva|pode\s+salvar|usa\s+esse|save\s+(?:it|that)|use\s+that)\b/i.test(lower);

    if (
      shortAffirmation ||
      conversationalFixAccept ||
      conversationalBudgetAccept ||
      conversationalCheckAccept
    ) {
      return { kind: 'accept_proposal' };
    }
  }

  return { kind: 'continue_with_guidance', guidance: text };
}
