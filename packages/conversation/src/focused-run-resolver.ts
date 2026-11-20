import type { RunFocus } from './run-focus.js';

export type FocusedInstructionResolution =
  | { kind: 'accept_proposal' }
  | { kind: 'leave' }
  | { kind: 'skip_preflight'; guidance?: string }
  | { kind: 'set_check_command'; command: string }
  | { kind: 'run_shell_command'; command: string }
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

  // 6. Natural-language acceptance of TaskForge's proposed action (PT or EN).
  //    Examples: "sim", "ok", "pode fazer", "pode subir", "sobe o zaira",
  //    "sobe o serviço e continua", "resolve isso pra mim", "conserta e continua",
  //    "bora", "manda ver", "go ahead", "do it", "fix it and continue", "start it".
  if (focus.action.kind !== 'none') {
    const shortAffirmation =
      /^(?:sim|s|ok|okay|beleza|blz|bora|manda\s+ver|vai|pode|claro|fechou|perfeito|confirmo|aprovo|concordo|yes|y|yep|yeah|sure|go\s+ahead|proceed|continue|do\s+it|fix\s+it|start\s+it|run\s+it|apply\s+it|go)[.!?\s]*$/i.test(
        lower,
      );
    const conversationalFixAccept =
      focus.action.kind === 'fix' &&
      text.length <= 120 &&
      /^(?:pode\s+(?:fazer|subir|iniciar|rodar|consertar|corrigir|resolver|continuar|aplicar)|faz(?:er)?\s+isso|sobe\s+(?:o\s+)?(?:servi[cç]o|container|docker|banco|\w+)|inicia\s+(?:o\s+)?(?:servi[cç]o|container|\w+)|resolve\s+isso|conserta\s+(?:isso|o\s+ambiente)|corrige\s+(?:isso|o\s+ambiente)|start\s+(?:the\s+)?service|fix\s+(?:this|it|the\s+environment)|please\s+(?:fix|start|do\s+that|go\s+ahead))/i.test(
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
