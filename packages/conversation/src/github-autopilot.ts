import { ProcessRunner } from '@taskforge/execution';
import { GitService } from '@taskforge/workspace';
import { colors } from './theme.js';

export type GitHubAutopilotCommand =
  | { kind: 'fix_ci'; runId?: string; language: 'pt' | 'en' }
  | { kind: 'review_pr'; prNumber?: string; targets?: 'all' | string[]; language: 'pt' | 'en' }
  | { kind: 'issue'; issueNumber: string; language: 'pt' | 'en' };

export interface FailedCiRunInfo {
  runId: string;
  workflowName: string;
  branch: string;
  url: string;
  failedLogExcerpt: string;
}

export interface PullRequestReviewContext {
  number: string;
  title: string;
  url: string;
  author: string;
  baseRef: string;
  headRef: string;
  body: string;
  diff: string;
}

export interface GitHubIssueContext {
  number: string;
  title: string;
  url: string;
  labels: string[];
  body: string;
  comments: string[];
}

export type PendingGitHubAutopilotAction =
  | { kind: 'post_pr_review'; prNumber: string; prUrl: string; reviewBody: string; language: 'pt' | 'en' }
  | { kind: 'issue_handoff'; issue: GitHubIssueContext; language: 'pt' | 'en' };

/**
 * Parses `/fix-ci`, `/review-pr`, `/issue`, and their PT/EN natural-language
 * equivalents so developers can close the entire GitHub loop inside `tf`.
 */
export function parseGitHubAutopilotCommand(rawInput: string): GitHubAutopilotCommand | undefined {
  const text = rawInput.trim();
  if (!text) return undefined;

  // Slash commands
  const fixCiSlash = /^\/fix-ci(?:\s+(\d+))?$/i.exec(text);
  if (fixCiSlash) {
    return { kind: 'fix_ci', runId: fixCiSlash[1], language: 'en' };
  }

  const reviewPrSlash = /^\/review-pr(?:\s+#?(\d+))?$/i.exec(text);
  if (reviewPrSlash) {
    return { kind: 'review_pr', prNumber: reviewPrSlash[1], targets: 'all', language: 'en' };
  }

  const issueSlash = /^\/issue(?:\s+#?(\d+))$/i.exec(text);
  if (issueSlash) {
    return { kind: 'issue', issueNumber: issueSlash[1], language: 'en' };
  }

  if (text.startsWith('/') || text.startsWith('@') || text.startsWith('!') || text.length > 140) {
    return undefined;
  }

  const lower = text.toLowerCase();
  const isPt = /\b(?:corrig\w*|arrum\w*|revis\w*|analis\w*|resolv\w*|desse|dessa|esse|essa|da|do)\b/i.test(lower);
  const language: 'pt' | 'en' = isPt ? 'pt' : 'en';

  // Natural language: "corrige o CI", "fix ci", "corrige o CI desse PR"
  if (
    /^(?:(?:corrig[ae]|arrum[ae]|consert[ae]|fix|repair)\s+(?:o\s+|the\s+)?(?:ci|build\s+do\s+ci|github\s+actions?)(?:\s+(?:desse\s+pr|desta\s+branch|on\s+this\s+pr|for\s+this\s+branch))?)[!.?]*$/i.test(
      lower,
    )
  ) {
    return { kind: 'fix_ci', language };
  }

  // Natural language: "revisa o PR #123", "review PR #42"
  const nlReviewPr =
    /^(?:revis[ae](?:r)?|analis[ae](?:r)?|review)\s+(?:o\s+|the\s+)?(?:pr|pull\s+request)(?:\s+#?(\d+))?[!.?]*$/i.exec(
      lower,
    );
  if (nlReviewPr) {
    return { kind: 'review_pr', prNumber: nlReviewPr[1], targets: 'all', language };
  }

  // Natural language: "resolve a issue #42", "solve issue #42"
  const nlIssue =
    /^(?:resolv[ae](?:r)?|trabalh[ae]\s+na|peg[ae]\s+a|solve|fix|work\s+on|inspect|ver)\s+(?:a\s+|the\s+)?issue\s+#?(\d+)[!.?]*$/i.exec(
      lower,
    );
  if (nlIssue) {
    return { kind: 'issue', issueNumber: nlIssue[1], language };
  }

  return undefined;
}

async function runGh(repoRoot: string, args: string[], timeoutMs = 25_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await ProcessRunner.run({
    command: 'gh',
    args,
    cwd: repoRoot,
    timeoutMs,
  });
  return {
    ok: res.exitCode === 0,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  };
}

export async function fetchLatestFailedCiRun(
  repoRoot: string,
  explicitRunId?: string,
  gitService?: GitService,
): Promise<{ info?: FailedCiRunInfo; error?: string }> {
  const git = gitService ?? new GitService(repoRoot);
  const branch = (await git.getStatus(repoRoot).catch(() => undefined))?.currentBranch || '';

  let runId = explicitRunId;
  let workflowName = 'CI';
  let url = '';

  if (!runId) {
    const listArgs = [
      'run',
      'list',
      ...(branch && branch !== 'HEAD' ? ['--branch', branch] : []),
      '--status',
      'failure',
      '--limit',
      '1',
      '--json',
      'databaseId,workflowName,url,headBranch',
    ];
    const list = await runGh(repoRoot, listArgs);
    if (!list.ok) {
      return { error: list.stderr || 'Failed to query GitHub Actions via `gh run list`.' };
    }
    try {
      const parsed = JSON.parse(list.stdout) as Array<{
        databaseId: number;
        workflowName?: string;
        url?: string;
        headBranch?: string;
      }>;
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { error: `No failed GitHub Actions runs found${branch ? ` on branch "${branch}"` : ''}.` };
      }
      runId = String(parsed[0].databaseId);
      workflowName = parsed[0].workflowName || 'CI';
      url = parsed[0].url || '';
    } catch {
      return { error: 'Could not parse `gh run list` output.' };
    }
  }

  const logRes = await runGh(repoRoot, ['run', 'view', runId, '--log-failed'], 35_000);
  if (!logRes.ok && !logRes.stdout) {
    return { error: logRes.stderr || `Could not fetch failed logs for CI run ${runId}.` };
  }
  const lines = logRes.stdout.split('\n');
  const excerpt = lines.slice(-120).join('\n').slice(-7000);

  return {
    info: {
      runId,
      workflowName,
      branch,
      url,
      failedLogExcerpt: excerpt || '(no failed log lines returned)',
    },
  };
}

export async function fetchPullRequestContext(
  repoRoot: string,
  prNumber?: string,
): Promise<{ pr?: PullRequestReviewContext; error?: string }> {
  const viewArgs = [
    'pr',
    'view',
    ...(prNumber ? [prNumber] : []),
    '--json',
    'number,title,url,author,baseRefName,headRefName,body',
  ];
  const view = await runGh(repoRoot, viewArgs);
  if (!view.ok) {
    return { error: view.stderr || 'Could not load PR via `gh pr view`. Specify a PR number: /review-pr 123' };
  }
  let meta: {
    number: number;
    title: string;
    url: string;
    author?: { login?: string };
    baseRefName?: string;
    headRefName?: string;
    body?: string;
  };
  try {
    meta = JSON.parse(view.stdout);
  } catch {
    return { error: 'Could not parse `gh pr view` JSON.' };
  }

  const diffRes = await runGh(repoRoot, ['pr', 'diff', String(meta.number)], 30_000);
  const diff = (diffRes.stdout || '').slice(0, 12_000);

  return {
    pr: {
      number: String(meta.number),
      title: meta.title || `PR #${meta.number}`,
      url: meta.url || '',
      author: meta.author?.login || 'unknown',
      baseRef: meta.baseRefName || 'main',
      headRef: meta.headRefName || '',
      body: (meta.body || '').slice(0, 2000),
      diff,
    },
  };
}

export async function postPullRequestReviewComment(
  repoRoot: string,
  prNumber: string,
  body: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await runGh(repoRoot, ['pr', 'comment', prNumber, '--body', body]);
  if (!res.ok) {
    return { ok: false, message: `${colors.red}✖ Failed to post PR comment:${colors.reset} ${res.stderr}` };
  }
  return {
    ok: true,
    message: `${colors.green}✔${colors.reset} Posted multi-agent review comment on PR #${prNumber}${res.stdout ? ` (${res.stdout})` : ''}.`,
  };
}

export async function fetchGitHubIssueContext(
  repoRoot: string,
  issueNumber: string,
): Promise<{ issue?: GitHubIssueContext; error?: string }> {
  const view = await runGh(repoRoot, [
    'issue',
    'view',
    issueNumber,
    '--json',
    'number,title,url,labels,body,comments',
  ]);
  if (!view.ok) {
    return { error: view.stderr || `Could not fetch issue #${issueNumber} via gh CLI.` };
  }
  try {
    const data = JSON.parse(view.stdout) as {
      number: number;
      title: string;
      url?: string;
      labels?: Array<{ name?: string }>;
      body?: string;
      comments?: Array<{ author?: { login?: string }; body?: string }>;
    };
    return {
      issue: {
        number: String(data.number),
        title: data.title || `Issue #${issueNumber}`,
        url: data.url || '',
        labels: (data.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
        body: (data.body || '').slice(0, 4000),
        comments: (data.comments ?? [])
          .slice(-5)
          .map((c) => `@${c.author?.login ?? 'user'}: ${(c.body ?? '').slice(0, 500)}`),
      },
    };
  } catch {
    return { error: `Could not parse issue #${issueNumber} output.` };
  }
}

export function buildFixCiPrompt(info: FailedCiRunInfo): string {
  return [
    `Fix the failing GitHub Actions CI run #${info.runId} (${info.workflowName}${info.branch ? ` on branch ${info.branch}` : ''}).`,
    'Diagnose the root cause from the failed CI log excerpt below, apply the minimal clean fix, and run the relevant local check to confirm.',
    '',
    'Failed CI log excerpt:',
    '```',
    info.failedLogExcerpt,
    '```',
  ].join('\n');
}

export function buildPrReviewPrompt(pr: PullRequestReviewContext): string {
  return [
    `Independent Code Review of Pull Request #${pr.number}: "${pr.title}" (${pr.headRef} -> ${pr.baseRef})`,
    pr.body ? `\nPR Description:\n${pr.body}` : '',
    '\nPR Unified Diff:',
    '```diff',
    pr.diff || '(empty diff)',
    '```',
    '\nReview instructions (read-only):',
    '1. Identify real bugs, edge cases, regressions, security issues, or missing tests.',
    '2. Cite exact file paths and lines where possible.',
    '3. Conclude with a crisp verdict: Approve, Approve with nits, or Request changes.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatIssueContextDisplay(issue: GitHubIssueContext): string {
  const labels = issue.labels.length > 0 ? ` ${colors.dim}[${issue.labels.join(', ')}]${colors.reset}` : '';
  const lines = [
    `${colors.brand}✦ ${colors.bold}GitHub Issue #${issue.number}: ${issue.title}${colors.reset}${labels}`,
    issue.url ? `  ${colors.dim}${issue.url}${colors.reset}` : '',
    '',
    issue.body || `${colors.dim}(empty description)${colors.reset}`,
    '',
    `  ${colors.dim}↵ Enter: plan & implement via Orchestrator   ·   "council" to debate solutions first   ·   "blueprint" for a Living Plan   ·   /back to cancel${colors.reset}`,
  ].filter((l) => l !== '');
  return lines.join('\n');
}
