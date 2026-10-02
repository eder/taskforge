import * as path from 'node:path';
import { PlannerProvenance } from '@taskforge/shared';
import { RoutingDecision } from '@taskforge/router';

export function formatApproxTokens(value: number): string {
  if (value < 1000) return value.toLocaleString();
  const thousands = value / 1000;
  return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, (match) => `\\${match}`);
}
/**
 * Agent output should describe the user's repository, not TaskForge's internal
 * worktree implementation. Convert absolute repo/worktree paths to stable
 * repository-relative paths before rendering them.
 */
export function sanitizeDisplayedRepositoryPaths(text: string, repoRoot: string): string {
  const roots = new Set([
    path.resolve(repoRoot),
    path.resolve(repoRoot).replace(/\\/g, '/'),
  ]);

  let sanitized = text;
  for (const root of roots) {
    const escapedRoot = escapeRegExp(root);
    const separator = '[\\\\/]';
    const worktreePrefix = new RegExp(
      escapedRoot +
        separator +
        '\\.taskforge' +
        separator +
        'worktrees' +
        separator +
        '[^\\s)\\]}>]+' +
        separator +
        '[^\\s)\\]}>]+' +
        separator,
      'g',
    );
    sanitized = sanitized.replace(worktreePrefix, '');
    sanitized = sanitized.replace(new RegExp(escapedRoot + separator, 'g'), '');
  }

  return sanitized;
}

export function plannerSourceLabel(
  plannerMeta: PlannerProvenance | undefined,
  graphMetadata: Record<string, unknown> | undefined,
): string {
  if (
    plannerMeta?.source === 'deterministic_decomposition' &&
    plannerMeta.fallbackReason === 'lightweight_read_only_fast_path'
  ) {
    return 'Deterministic fast path (lightweight read-only; model call skipped)';
  }

  if (plannerMeta?.source === 'semantic_model') {
    const providerLabel = plannerMeta.provider === 'custom' ? 'Custom' : 'Semantic';
    return `${providerLabel} / ${plannerMeta.model || 'gpt-5.6-luna'}`;
  }

  if (plannerMeta?.source === 'deterministic_decomposition') {
    return `Deterministic decomposition${plannerMeta.fallbackReason ? ` (${plannerMeta.fallbackReason})` : ''}`;
  }

  if (plannerMeta?.source === 'heuristic_fallback') {
    return `Heuristic fallback${plannerMeta.fallbackReason ? ` (${plannerMeta.fallbackReason})` : ''}`;
  }

  if (graphMetadata?.source === 'semantic') {
    return `Semantic / ${String(graphMetadata.model ?? 'gpt-5.6-luna')}`;
  }

  return `Heuristic fallback${graphMetadata?.fallbackReason ? ` (${String(graphMetadata.fallbackReason)})` : ''}`;
}

export function routerSourceLabel(
  routing: RoutingDecision,
  model: string,
  lightweightFastPath: boolean,
): string {
  if (routing.source === 'openai') {
    return `OpenAI / ${model || 'gpt-5.6-luna'}`;
  }
  if (routing.source === 'adaptive') {
    return 'Adaptive structure / deterministic agent fit';
  }
  if (lightweightFastPath) {
    return 'Deterministic routing (model call not required)';
  }

  const fallbackReason = routing.fallbackReason;
  const fallbackDetail = routing.fallbackDetail;
  return fallbackReason
    ? `Static fallback (Reason: ${fallbackReason}${fallbackDetail ? `, ${fallbackDetail}` : ''})`
    : 'Static / deterministic';
}

export function findWordLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  while (i > 0 && /\s/.test(text[i])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

export function findWordRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let i = pos;
  while (i < text.length && !/\s/.test(text[i])) i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * One-line summary of a (possibly huge) goal for list views: the first
 * non-empty line, whitespace collapsed, cut at a word boundary.
 */
export function summarizeGoal(text: string, maxLength = 110): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ');
  if (collapsed.length <= maxLength) {
    return text.trim().includes('\n') && text.trim() !== collapsed ? `${collapsed} …` : collapsed;
  }
  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()} …`;
}
