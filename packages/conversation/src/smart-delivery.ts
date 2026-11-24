import { colors } from './theme.js';

export type DeliveryActionKind = 'pr' | 'commit' | 'apply';

export interface RequestedDeliveryIntent {
  kind: DeliveryActionKind;
  language: 'pt' | 'en';
}

export interface PendingOrchestratedDelivery {
  runId: string;
  branch: string;
  targetBranch: string;
  verified: boolean;
  recommendedAction: 'pr' | 'apply' | 'diff';
  requestedByUser?: DeliveryActionKind;
  language: 'pt' | 'en';
}

export type DeliveryFollowUpReply = 'accept' | 'pr' | 'apply' | 'diff' | 'discard';

const PT_LANGUAGE_CUE =
  /\b(?:para|com|isso|essa|esse|uma|um|abre|abrir|cria|criar|faz|fazer|fa[çc]a|commita\w*|aplica\w*|mescla\w*|corrige|corrigir|adiciona\w*|refatora\w*|atualiza\w*|depois|ent[aã]o|j[aá]|na\s+branch|na\s+main)\b/i;

/**
 * Extracts an explicit post-success delivery preference stated inside a user's
 * task prompt (e.g. "fix X and open a PR", "corrige Y e já faz commit",
 * "implementa Z, commita e abre PR"). This is advisory only: deterministic
 * verification and safety gates still govern execution.
 */
export function extractRequestedDeliveryIntent(rawPrompt: string): RequestedDeliveryIntent | undefined {
  const text = rawPrompt.trim();
  if (!text || text.startsWith('/') || text.startsWith('!')) return undefined;

  const lower = text.toLowerCase();
  const language: 'pt' | 'en' = PT_LANGUAGE_CUE.test(lower) ? 'pt' : 'en';

  // PR intent takes precedence over commit when both are mentioned ("commita e abre PR").
  const wantsPr =
    /(?:(?:\be\b|,|;|depois|ent[aã]o|and|then|\+)\s*(?:j[aá]\s+)?(?:pode\s+)?(?:abr(?:e|ir|a)|cri(?:a|ar|e)|faz(?:er)?|fa[çc]a|open|create|submit|raise|make)\s+(?:um[ao]?\s+|o\s+|a\s+|the\s+)?(?:pull\s+request|\bpr\b))|(?:(?:commita\w*|commit)\s+(?:e|and)\s+(?:j[aá]\s+)?(?:abr(?:e|ir|a)|cri(?:a|ar|e)|open|create)\s+(?:um[ao]?\s+|o\s+|a\s+)?(?:pull\s+request|\bpr\b))/i.test(
      lower,
    );
  if (wantsPr) {
    return { kind: 'pr', language };
  }

  const wantsCommit =
    /(?:(?:\be\b|,|;|depois|ent[aã]o|and|then|\+)\s*(?:j[aá]\s+)?(?:pode\s+)?(?:(?:faz(?:er)?|fa[çc]a|cri(?:a|ar|e)|make|create)\s+(?:um\s+|o\s+)?(?:git\s+)?commit|commita(?:r)?|commit(?:\s+(?:it|this|that|everything|the\s+changes|changes|all))?))\b/i.test(
      lower,
    );
  if (wantsCommit) {
    return { kind: 'commit', language };
  }

  const wantsApply =
    /(?:(?:\be\b|,|;|depois|ent[aã]o|and|then|\+)\s*(?:j[aá]\s+)?(?:pode\s+)?(?:aplica(?:r)?|apply|merge(?:ar)?|mescla(?:r)?)(?:\s+(?:isso|tudo|it|this|na\s+branch|na\s+main|to\s+main|into\s+main))?)\b/i.test(
      lower,
    );
  if (wantsApply) {
    return { kind: 'apply', language };
  }

  return undefined;
}

export interface BuildOrchestratedDeliveryProposalInput {
  runId: string;
  branch: string;
  targetBranch: string;
  verified: boolean;
  gitWorkflow?: string;
  deliveryMode?: string;
  requestedByUser?: DeliveryActionKind;
  language?: 'pt' | 'en';
}

/**
 * Builds an intelligent, context-aware post-success delivery prompt for a
 * completed orchestrated run. Unverified runs NEVER recommend 1-Enter apply/PR;
 * they recommend inspecting the diff first.
 */
export function buildOrchestratedDeliveryProposal(
  input: BuildOrchestratedDeliveryProposalInput,
): { pending: PendingOrchestratedDelivery; formatted: string } {
  const language: 'pt' | 'en' = input.language ?? 'en';
  const isProtectedTarget = input.targetBranch === 'main' || input.targetBranch === 'master';

  let recommendedAction: 'pr' | 'apply' | 'diff';
  if (!input.verified) {
    recommendedAction = 'diff';
  } else if (input.requestedByUser === 'pr') {
    recommendedAction = 'pr';
  } else if (input.requestedByUser === 'apply' || input.requestedByUser === 'commit') {
    recommendedAction = 'apply';
  } else if (
    input.deliveryMode === 'pull_request' ||
    input.gitWorkflow === 'github-flow' ||
    (isProtectedTarget && input.gitWorkflow === 'gitflow')
  ) {
    recommendedAction = 'pr';
  } else {
    recommendedAction = 'apply';
  }

  const pending: PendingOrchestratedDelivery = {
    runId: input.runId,
    branch: input.branch,
    targetBranch: input.targetBranch,
    verified: input.verified,
    recommendedAction,
    ...(input.requestedByUser ? { requestedByUser: input.requestedByUser } : {}),
    language,
  };

  if (language === 'pt') {
    if (!input.verified) {
      return {
        pending,
        formatted: [
          `  ${colors.brand}✦ ${colors.bold}Pronto para entrega${colors.reset} ${colors.dim}(${input.runId} · ${colors.yellow}⚠ sem checks automatizados${colors.reset}${colors.dim})${colors.reset}`,
          `  Recomendo revisar o diff antes de aplicar em ${colors.cyan}${input.targetBranch}${colors.reset} ou abrir PR.`,
          `  ${colors.dim}↵ Enter: ver diff   ·   "aplica" ou "abre pr" para prosseguir   ·   "descarta" para manter só a branch${colors.reset}`,
        ].join('\n'),
      };
    }
    if (recommendedAction === 'pr') {
      const requestedNote = input.requestedByUser === 'pr' ? ' (conforme pedido)' : '';
      return {
        pending,
        formatted: [
          `  ${colors.brand}✦ ${colors.bold}Pronto para entrega${colors.reset} ${colors.dim}(${input.runId} · verificado ✔)${colors.reset}`,
          `  Quer abrir uma PR para ${colors.cyan}${input.targetBranch}${colors.reset}${requestedNote}, aplicar direto ou ver o diff?`,
          `  ${colors.dim}↵ Enter / sim: abrir PR   ·   "aplica" para aplicar em ${input.targetBranch}   ·   "diff" para revisar   ·   "descarta" para cancelar${colors.reset}`,
        ].join('\n'),
      };
    }
    return {
      pending,
      formatted: [
        `  ${colors.brand}✦ ${colors.bold}Pronto para entrega${colors.reset} ${colors.dim}(${input.runId} · verificado ✔)${colors.reset}`,
        `  Quer aplicar em ${colors.cyan}${input.targetBranch}${colors.reset}, abrir uma PR ou ver o diff?`,
        `  ${colors.dim}↵ Enter / sim: aplicar em ${input.targetBranch}   ·   "pr" para abrir PR   ·   "diff" para revisar   ·   "descarta" para cancelar${colors.reset}`,
      ].join('\n'),
    };
  }

  if (!input.verified) {
    return {
      pending,
      formatted: [
        `  ${colors.brand}✦ ${colors.bold}Ready to deliver${colors.reset} ${colors.dim}(${input.runId} · ${colors.yellow}⚠ not verified${colors.reset}${colors.dim})${colors.reset}`,
        `  Review the diff before applying to ${colors.cyan}${input.targetBranch}${colors.reset} or opening a PR.`,
        `  ${colors.dim}↵ Enter: view diff   ·   "apply" or "open pr" to proceed   ·   "discard" to keep branch only${colors.reset}`,
      ].join('\n'),
    };
  }
  if (recommendedAction === 'pr') {
    const requestedNote = input.requestedByUser === 'pr' ? ' (as requested)' : '';
    return {
      pending,
      formatted: [
        `  ${colors.brand}✦ ${colors.bold}Ready to deliver${colors.reset} ${colors.dim}(${input.runId} · verified ✔)${colors.reset}`,
        `  Open a PR against ${colors.cyan}${input.targetBranch}${colors.reset}${requestedNote}, apply directly, or inspect the diff?`,
        `  ${colors.dim}↵ Enter / yes: open PR   ·   "apply" for ${input.targetBranch}   ·   "diff" to inspect   ·   "discard" to cancel${colors.reset}`,
      ].join('\n'),
    };
  }
  return {
    pending,
    formatted: [
      `  ${colors.brand}✦ ${colors.bold}Ready to deliver${colors.reset} ${colors.dim}(${input.runId} · verified ✔)${colors.reset}`,
      `  Apply to ${colors.cyan}${input.targetBranch}${colors.reset}, open a PR, or inspect the diff?`,
      `  ${colors.dim}↵ Enter / yes: apply to ${input.targetBranch}   ·   "pr" to open PR   ·   "diff" to inspect   ·   "discard" to cancel${colors.reset}`,
    ].join('\n'),
  };
}

/**
 * Parses concise natural-language replies to a pending orchestrated delivery
 * prompt. Returns `undefined` for unrelated messages so the user is never
 * trapped in the delivery prompt.
 */
export function parseDeliveryFollowUpReply(rawText: string): DeliveryFollowUpReply | undefined {
  const text = rawText.trim();
  if (!text || text.startsWith('/') || text.startsWith('@') || text.startsWith('!')) {
    return undefined;
  }
  if (text.length > 80) return undefined;

  const lower = text.toLowerCase().replace(/[.!?]+$/, '').trim();

  if (/^(?:y|yes|s|sim|ok|confirm(?:a|ar)?|pode|vai|manda|go|beleza|fechado|bora|aprovo)$/.test(lower)) {
    return 'accept';
  }
  if (
    /^(?:(?:abr(?:e|ir|a)|cri(?:a|ar|e)|faz(?:er)?|fa[çc]a|pode\s+abrir|open|create|make)\s+)?(?:um[ao]?\s+|o\s+|a\s+)?(?:pr|pull\s+request)(?:\s+(?:disso|agora|now|por\s+favor|please))?$/.test(
      lower,
    ) ||
    /^(?:commita\w*|commit)\s+(?:e|and)\s+(?:abr(?:e|ir|a)|cri(?:a|ar|e)|open|create)\s+(?:um[ao]?\s+|o\s+|a\s+)?(?:pr|pull\s+request)$/.test(
      lower,
    )
  ) {
    return 'pr';
  }
  if (
    /^(?:(?:pode\s+|faz(?:er)?\s+)?(?:aplica(?:r)?|apply|merge(?:ar)?|mescla(?:r)?|commita(?:r)?|commit)(?:\s+(?:isso|tudo|agora|now|na\s+branch|na\s+main|to\s+main|it|this))?|faz(?:er)?\s+(?:o\s+|um\s+)?commit)$/.test(
      lower,
    )
  ) {
    return 'apply';
  }
  if (
    /^(?:(?:ver|mostr[ae]|exib[ae]|show|view|review)\s+(?:o\s+|the\s+)?)?(?:diff|mudan[çc]as|changes)$/.test(
      lower,
    )
  ) {
    return 'diff';
  }
  if (
    /^(?:descarta(?:r)?|discard|cancel(?:a|ar)?|n[aã]o|no|deixa|mant[eé]m(?:\s+na\s+branch)?|keep\s+branch|skip|q)$/.test(
      lower,
    )
  ) {
    return 'discard';
  }

  return undefined;
}

/**
 * Formats a concise, context-aware post-edit delivery suggestion for Direct Mode
 * when the user did not already specify commit/PR in their prompt.
 */
export function formatDirectPostEditHint(
  filesChanged: readonly string[],
  branch: string,
  language: 'pt' | 'en',
): string {
  const isDefaultBranch = branch === 'main' || branch === 'master' || branch === 'HEAD';
  const count = filesChanged.length;
  if (language === 'pt') {
    const primary = isDefaultBranch
      ? `"abre um pr" (cria branch + commit + PR) ou "faz commit"`
      : `"faz commit" na branch ${branch} ou "abre um pr"`;
    return `${colors.dim}💡 ${count} arquivo(s) atualizado(s) com checkpoint. Quando quiser, diga ${primary}, "mostra o diff" ou "desfaz".${colors.reset}`;
  }
  const primary = isDefaultBranch
    ? `"open a pr" (branch + commit + PR) or "commit"`
    : `"commit" on ${branch} or "open a pr"`;
  return `${colors.dim}💡 ${count} file(s) updated with checkpoint. Whenever ready, say ${primary}, "show diff", or "undo".${colors.reset}`;
}
