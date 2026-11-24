import { ProcessRunner } from '@taskforge/execution';
import { GitService } from '@taskforge/workspace';
import { colors } from './theme.js';
import type { DirectSessionEntry } from './direct-agent-session.js';

export type DirectGitIntent =
  | { kind: 'undo'; language: 'pt' | 'en' }
  | { kind: 'diff'; language: 'pt' | 'en' }
  | { kind: 'status'; language: 'pt' | 'en' }
  | { kind: 'commit'; message?: string; language: 'pt' | 'en' }
  | { kind: 'pr'; title?: string; language: 'pt' | 'en' };

export type PendingDirectGitAction =
  | {
      kind: 'commit';
      files: string[];
      message: string;
      language: 'pt' | 'en';
    }
  | {
      kind: 'pr';
      branch: string;
      baseBranch: string;
      title: string;
      body: string;
      needsBranch?: string;
      needsCommit?: boolean;
      commitMessage?: string;
      files: string[];
      language: 'pt' | 'en';
    };

const PT_GIT_CUE =
  /\b(?:desfaz\w*|reverte\w*|mostr\w*|ver\b|mudou|alterad\w*|arquivos?|faz(?:er)?|fa[çc]a|commita\w*|abre|abrir|cria(?:r)?|mensagem|t[ií]tulo|[uú]ltim[ao])\b/i;

const ENGINEERING_TASK_GUARD =
  /\b(?:implement\w*|refactor\w*|refator\w*|corrig\w*|fix\b|bug\b|erro\b|fun[çc][aã]o|function|class\b|classe\b|endpoint|teste?s?\b|tests?\b)\b|\.(?:ts|tsx|js|jsx|py|go|rs|swift|java|md|json|yaml|yml)\b/i;

/**
 * Parses concise natural-language Git & Undo actions (PT & EN) so users in
 * Direct Mode or Auto Mode can inspect diffs, undo edits, commit changes, and
 * open PRs conversationally without leaving `tf`.
 */
export function parseDirectGitIntent(rawText: string): DirectGitIntent | undefined {
  const text = rawText.trim();
  if (!text || text.startsWith('/') || text.startsWith('@') || text.startsWith('!')) {
    return undefined;
  }
  if (text.length > 160) return undefined;

  const lower = text.toLowerCase();
  const language: 'pt' | 'en' = PT_GIT_CUE.test(lower) ? 'pt' : 'en';

  // 1. Undo direct edit
  if (
    /^(?:desfaz(?:er)?|reverte(?:r)?)(?:\s+(?:isso|tudo|a\s+[uú]ltim[ao]\s+(?:altera[çc][aã]o|edi[çc][aã]o|mudan[çc]a)|o\s+[uú]ltimo\s+(?:edit|cambio|ajuste)))?[!.?]*$/i.test(
      lower,
    ) ||
    /^(?:undo|revert)(?:\s+(?:that|this|last(?:\s+(?:edit|change|turn))?))?[!.?]*$/i.test(lower)
  ) {
    return { kind: 'undo', language };
  }

  // Extract optional quoted message/title before guarding against code tasks.
  const quotedMatch = /["'“”]([^"'“”]{2,120})["'“”]/.exec(text);
  const withoutQuote = quotedMatch ? text.replace(quotedMatch[0], '').trim() : text;
  if (ENGINEERING_TASK_GUARD.test(withoutQuote)) {
    return undefined;
  }

  // 2. Show diff
  if (
    /^(?:(?:mostr[ae]|ver|exib[ae]|qual\s+[eé]|show|view|print|display)\s+(?:o\s+|the\s+)?)?(?:git\s+)?diff(?:\s+(?:atual|local|disso))?[!.?]*$/i.test(
      lower,
    ) ||
    /^(?:o\s+que\s+(?:mudou|foi\s+alterado|eu\s+mudei|voc[eê]\s+mudou)|what\s+changed|show\s+(?:me\s+)?(?:the\s+)?changes)[!.?]*$/i.test(
      lower,
    )
  ) {
    return { kind: 'diff', language };
  }

  // 3. Git status
  if (
    /^(?:(?:mostr[ae]|ver|show|check)\s+(?:o\s+|the\s+)?)?(?:git\s+status|status\s+do\s+git|quais\s+arquivos\s+mudaram|what\s+files\s+changed)[!.?]*$/i.test(
      lower,
    )
  ) {
    return { kind: 'status', language };
  }

  // 4. Open Pull Request (also handles combined "commita e abre pr" / "commit and open pr" — checked before commit)
  const prMatch =
    /^(?:(?:(?:faz(?:er)?|fa[çc]a|pode\s+)?(?:commit(?:a(?:r)?)?|git\s+commit)(?:\s+(?:isso|disso|tudo|this|all))?\s+(?:e|and)\s+(?:j[aá]\s+)?)?(?:abr[aeir]+|cria(?:r)?|faz(?:er)?|fa[çc]a|pode\s+abrir|open|create|make)\s+(?:um[ao]?\s+|o\s+|a\s+)?)(?:pr|pull\s+request)(?:\s+(?:disso|dessa\s+branch|for\s+this))?(?:\s+(?:com\s+(?:o\s+)?t[ií]tulo|titled|with\s+title)\s*[:=]?\s*(.+))?$/i.exec(
      text,
    );
  if (prMatch && !/\brun-\d+\b/i.test(withoutQuote)) {
    const rawTitle = (quotedMatch?.[1] ?? prMatch[1] ?? '').trim().replace(/^["'“”]|["'“”]$/g, '');
    return {
      kind: 'pr',
      ...(rawTitle ? { title: rawTitle } : {}),
      language,
    };
  }

  // 5. Commit working tree changes
  const commitMatch =
    /^(?:(?:faz(?:er)?|fa[çc]a|cria(?:r)?|pode(?:\s+fazer)?|make|create|do)\s+(?:um\s+|o\s+|a\s+)?)?(?:git\s+)?commit(?:a(?:r)?)?(?:\s+(?:disso|isso|as\s+altera[çc][õo]es|tudo|this|these(?:\s+changes)?|all))?(?:\s+(?:com\s+(?:a\s+)?mensagem|with\s+message|-m)\s*[:=]?\s*(.+))?$/i.exec(
      text,
    );
  if (commitMatch && !/\b(?:run-\d+|pull\s+request|\bpr\b)\b/i.test(withoutQuote)) {
    const rawMsg = (quotedMatch?.[1] ?? commitMatch[1] ?? '').trim().replace(/^["'“”]|["'“”]$/g, '');
    return {
      kind: 'commit',
      ...(rawMsg ? { message: rawMsg } : {}),
      language,
    };
  }

  return undefined;
}

async function listDirtyFiles(repoRoot: string, git: GitService): Promise<string[]> {
  const raw = await git.exec(['status', '--porcelain'], repoRoot).catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*[MADRCU?!]{1,2}\s+/, '').trim())
    .filter(Boolean);
}

function suggestMessageFromMemory(
  entries: readonly DirectSessionEntry[],
  files: string[],
): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'user' && e.text.trim().length > 4) {
      const cleaned = e.text
        .replace(/^\[[^\]]+\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length >= 4 && !/^(?:faz|commit|abre|pr|diff|status|desfaz|undo)/i.test(cleaned)) {
        const summary = cleaned.slice(0, 68).replace(/[.?!]+$/, '');
        return `chore: ${summary}`;
      }
    }
  }
  if (files.length === 1) return `chore: update ${files[0]}`;
  if (files.length > 1) return `chore: update ${files[0]} and ${files.length - 1} other file(s)`;
  return 'chore: apply working tree changes';
}

function slugifyBranch(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/^(?:chore|feat|fix|refactor|docs):\s*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return `feat/${slug || `direct-${Date.now().toString(36)}`}`;
}

export async function formatWorkingTreeDiff(
  repoRoot: string,
  git: GitService,
  language: 'pt' | 'en',
): Promise<{ hasChanges: boolean; formatted: string }> {
  const files = await listDirtyFiles(repoRoot, git);
  if (files.length === 0) {
    return {
      hasChanges: false,
      formatted:
        language === 'pt'
          ? `${colors.dim}Working tree limpo — nenhuma alteração local para mostrar.${colors.reset}`
          : `${colors.dim}Working tree is clean — no local changes to show.${colors.reset}`,
    };
  }

  const stat = (await git.exec(['diff', 'HEAD', '--stat'], repoRoot).catch(() => '')).trim();
  const diff = (await git.exec(['diff', 'HEAD'], repoRoot).catch(() => '')).trim();
  const untrackedRaw = (await git.exec(['ls-files', '--others', '--exclude-standard'], repoRoot).catch(() => '')).trim();
  const untracked = untrackedRaw ? untrackedRaw.split('\n').filter(Boolean) : [];

  const lines: string[] = [
    `${colors.brand}✦ ${colors.bold}Working Tree Diff${colors.reset} ${colors.dim}(${files.length} file${files.length === 1 ? '' : 's'})${colors.reset}`,
  ];
  if (stat) lines.push(stat);
  if (untracked.length > 0) {
    lines.push(`${colors.cyan}Untracked files:${colors.reset} ${untracked.join(', ')}`);
  }
  if (diff) {
    const diffLines = diff.split('\n');
    const preview =
      diffLines.length > 120
        ? [...diffLines.slice(0, 120), `${colors.dim}... (${diffLines.length - 120} more lines omitted — run !git diff for full output)${colors.reset}`]
        : diffLines;
    lines.push('', ...preview);
  }
  return { hasChanges: true, formatted: lines.join('\n') };
}

export async function formatWorkingTreeStatus(
  repoRoot: string,
  git: GitService,
): Promise<string> {
  const statusShort = (await git.exec(['status', '-sb'], repoRoot).catch(() => '')).trim();
  return [
    `${colors.brand}✦ ${colors.bold}Git Status${colors.reset}`,
    statusShort
      ? statusShort
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')
      : `  ${colors.dim}(clean)${colors.reset}`,
  ].join('\n');
}

export async function prepareDirectCommit(
  repoRoot: string,
  git: GitService,
  explicitMessage: string | undefined,
  memoryEntries: readonly DirectSessionEntry[],
  language: 'pt' | 'en',
): Promise<{ formatted: string; pending?: PendingDirectGitAction }> {
  const files = await listDirtyFiles(repoRoot, git);
  if (files.length === 0) {
    return {
      formatted:
        language === 'pt'
          ? `${colors.yellow}⚠${colors.reset} Nenhuma alteração no working tree para commitar.`
          : `${colors.yellow}⚠${colors.reset} No working-tree changes to commit.`,
    };
  }

  const message = explicitMessage?.trim() || suggestMessageFromMemory(memoryEntries, files);
  const filePreview = files.slice(0, 12).map((f) => `  • ${colors.cyan}${f}${colors.reset}`);
  if (files.length > 12) {
    filePreview.push(`  ${colors.dim}… +${files.length - 12} more${colors.reset}`);
  }

  const header =
    language === 'pt'
      ? `${colors.brand}✦ ${colors.bold}Confirmar commit direto${colors.reset}`
      : `${colors.brand}✦ ${colors.bold}Confirm direct commit${colors.reset}`;
  const hint =
    language === 'pt'
      ? `↵ Enter / sim: commitar agora   ·   ou digite outra mensagem de commit   ·   /back para cancelar`
      : `↵ Enter / yes: commit now   ·   or type a custom commit message   ·   /back to cancel`;

  return {
    formatted: [
      header,
      ...filePreview,
      '',
      `  ${colors.dim}Message:${colors.reset} ${colors.bold}${message}${colors.reset}`,
      `  ${colors.dim}${hint}${colors.reset}`,
    ].join('\n'),
    pending: {
      kind: 'commit',
      files,
      message,
      language,
    },
  };
}

export async function executeDirectCommit(
  repoRoot: string,
  git: GitService,
  message: string,
  language: 'pt' | 'en',
): Promise<string> {
  try {
    const hash = await git.stageAndCommit(message, repoRoot);
    const shortHash = hash.slice(0, 7);
    return language === 'pt'
      ? `${colors.green}✔${colors.reset} Commit criado: ${colors.bold}${shortHash}${colors.reset} — ${message}`
      : `${colors.green}✔${colors.reset} Created commit: ${colors.bold}${shortHash}${colors.reset} — ${message}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${colors.red}✖ Commit failed:${colors.reset} ${msg}`;
  }
}

export async function prepareDirectPr(
  repoRoot: string,
  git: GitService,
  explicitTitle: string | undefined,
  memoryEntries: readonly DirectSessionEntry[],
  language: 'pt' | 'en',
): Promise<{ formatted: string; pending?: PendingDirectGitAction }> {
  const status = await git.getStatus(repoRoot);
  const branch = status.currentBranch || 'HEAD';
  const files = await listDirtyFiles(repoRoot, git);
  const isDefaultBranch = branch === 'main' || branch === 'master' || branch === 'HEAD';
  const baseBranch = branch === 'master' ? 'master' : 'main';

  const commitMessage = explicitTitle?.trim() || suggestMessageFromMemory(memoryEntries, files);
  const lastSubject = (
    await git.exec(['log', '-1', '--pretty=%s'], repoRoot).catch(() => '')
  ).trim();
  const title = explicitTitle?.trim() || (files.length > 0 ? commitMessage : lastSubject || 'Update changes');
  const needsBranch = isDefaultBranch ? slugifyBranch(title) : undefined;
  const needsCommit = files.length > 0;

  if (!needsCommit && isDefaultBranch) {
    return {
      formatted:
        language === 'pt'
          ? `${colors.yellow}⚠${colors.reset} Você está na branch ${colors.bold}${branch}${colors.reset} sem alterações pendentes para abrir um PR.`
          : `${colors.yellow}⚠${colors.reset} You are on ${colors.bold}${branch}${colors.reset} with no pending changes to open a PR.`,
    };
  }

  const steps: string[] = [];
  if (needsBranch) {
    steps.push(`  1. Create & switch to branch ${colors.cyan}${needsBranch}${colors.reset}`);
  }
  if (needsCommit) {
    steps.push(`  ${steps.length + 1}. Commit ${files.length} changed file(s): "${commitMessage}"`);
  }
  steps.push(`  ${steps.length + 1}. Push branch ${colors.cyan}${needsBranch ?? branch}${colors.reset} to origin`);
  steps.push(`  ${steps.length + 1}. Open PR against ${colors.cyan}${baseBranch}${colors.reset} via gh CLI`);

  const header =
    language === 'pt'
      ? `${colors.brand}✦ ${colors.bold}Confirmar abertura de Pull Request${colors.reset}`
      : `${colors.brand}✦ ${colors.bold}Confirm Pull Request creation${colors.reset}`;
  const hint =
    language === 'pt'
      ? `↵ Enter / sim: executar agora   ·   ou digite outro título   ·   /back para cancelar`
      : `↵ Enter / yes: proceed now   ·   or type a custom PR title   ·   /back to cancel`;

  return {
    formatted: [
      header,
      `  ${colors.dim}Title:${colors.reset} ${colors.bold}${title}${colors.reset}`,
      ...steps,
      `  ${colors.dim}${hint}${colors.reset}`,
    ].join('\n'),
    pending: {
      kind: 'pr',
      branch: needsBranch ?? branch,
      baseBranch,
      title,
      body: `## Summary\n\n${title}\n\nCreated directly from TaskForge Direct Mode.`,
      needsBranch,
      needsCommit,
      commitMessage,
      files,
      language,
    },
  };
}

export async function executeDirectPr(
  repoRoot: string,
  git: GitService,
  action: Extract<PendingDirectGitAction, { kind: 'pr' }>,
): Promise<string> {
  try {
    if (action.needsBranch) {
      await git.exec(['checkout', '-b', action.needsBranch], repoRoot);
    }
    if (action.needsCommit && action.commitMessage) {
      await git.stageAndCommit(action.commitMessage, repoRoot);
    }
    await git.exec(['push', '-u', 'origin', action.branch], repoRoot);

    const prRes = await ProcessRunner.run({
      command: 'gh',
      args: [
        'pr',
        'create',
        '--base',
        action.baseBranch,
        '--head',
        action.branch,
        '--title',
        action.title,
        '--body',
        action.body,
      ],
      cwd: repoRoot,
      timeoutMs: 30_000,
    });
    if (prRes.exitCode !== 0) {
      const errOut = [prRes.stderr, prRes.stdout].filter((s) => s.trim()).join('\n').trim();
      return `${colors.red}✖ Failed to open PR via gh CLI:${colors.reset} ${errOut || `exit ${prRes.exitCode}`}`;
    }
    const url = prRes.stdout.trim();
    return action.language === 'pt'
      ? `${colors.green}✔${colors.reset} Pull Request aberto: ${colors.cyan}${url}${colors.reset}`
      : `${colors.green}✔${colors.reset} Pull Request opened: ${colors.cyan}${url}${colors.reset}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${colors.red}✖ Pull Request creation failed:${colors.reset} ${msg}`;
  }
}
