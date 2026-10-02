import { TaskForgeConfig } from '@taskforge/shared';
import { Task } from '@taskforge/core';
import { AgentAdapter, AgentQuotaTracker } from '@taskforge/agents';
import { AgentFitScorer } from '@taskforge/router';
import { ruleMatchesScope } from './task-policy.js';

/**
 * Mandatory dual-review gate for sensitive tasks.
 *
 * Everything that decides *whether* review is required and *whether it passed*
 * is deterministic: sensitivity comes from configured scopes/keywords (never
 * from model output), the reviewer must be a different agent than whoever
 * wrote the change, and approval is an explicit verdict line that fails
 * closed when missing or ambiguous. The reviewer only supplies the opinion.
 */

export interface SensitivityAssessment {
  sensitive: boolean;
  reasons: string[];
}

export function assessTaskSensitivity(
  task: Task,
  config: TaskForgeConfig,
): SensitivityAssessment {
  const policy = config.verification.dualReview;
  if (!policy?.enabled) return { sensitive: false, reasons: [] };

  const reasons: string[] = [];

  if (task.contract.metadata?.sensitive === true) {
    reasons.push('task is explicitly flagged as sensitive');
  }

  for (const taskScope of task.contract.allowedScope ?? []) {
    for (const sensitiveScope of policy.scopes) {
      if (ruleMatchesScope(sensitiveScope, taskScope)) {
        reasons.push(`scope ${taskScope} matches sensitive scope ${sensitiveScope}`);
      }
    }
  }

  const text = `${task.title}\n${task.contract.objective}`.toLowerCase();
  for (const keyword of policy.keywords) {
    const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}`, 'i').test(text)) {
      reasons.push(`mentions "${keyword}"`);
    }
  }

  return { sensitive: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** Whether this task type changes code and therefore has something to review. */
export function taskProducesChanges(task: Task): boolean {
  if (task.contract.forbiddenChanges?.includes('*')) return false;
  return task.contract.completionMode !== 'report' && task.contract.completionMode !== 'review';
}

export type ReviewVerdict = 'approved' | 'rejected' | 'missing';

export interface ParsedReview {
  verdict: ReviewVerdict;
  /** Review text without the verdict line, used as rework evidence. */
  findings: string;
}

const VERDICT_LINE = /^\s*REVIEW_VERDICT\s*:\s*(APPROVED|REJECTED)\s*\.?\s*$/i;

/**
 * Fails closed: no verdict line => 'missing'; conflicting verdict lines =>
 * 'rejected'. Only a single consistent APPROVED verdict approves.
 */
export function parseReviewVerdict(output: string | undefined): ParsedReview {
  const lines = (output ?? '').split('\n');
  const verdicts = new Set<'approved' | 'rejected'>();
  const rest: string[] = [];
  for (const line of lines) {
    const match = VERDICT_LINE.exec(line);
    if (match) {
      verdicts.add(match[1].toUpperCase() === 'APPROVED' ? 'approved' : 'rejected');
    } else {
      rest.push(line);
    }
  }
  const findings = rest.join('\n').trim();
  if (verdicts.size === 0) return { verdict: 'missing', findings };
  if (verdicts.size > 1 || verdicts.has('rejected')) return { verdict: 'rejected', findings };
  return { verdict: 'approved', findings };
}

export function buildDualReviewObjective(params: {
  task: Task;
  implementerAgentIds: string[];
  candidateCommit: string;
  baseCommit: string;
  reasons: string[];
}): string {
  const { task, implementerAgentIds, candidateCommit, baseCommit, reasons } = params;
  return [
    `You are the INDEPENDENT REVIEWER for task ${task.id}: "${task.title}".`,
    `This task is flagged sensitive (${reasons.join('; ')}). Another agent (${implementerAgentIds.join(', ')}) wrote the change; it must not reach the run branch without your approval.`,
    '',
    `Review the change introduced by commit ${candidateCommit} relative to ${baseCommit}`,
    `(for example: git diff ${baseCommit} ${candidateCommit}). The repository is checked out at the candidate commit. Do NOT modify any files.`,
    '',
    `Task objective: ${task.contract.objective}`,
    'Acceptance criteria:',
    ...task.contract.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    'Check correctness against the objective and criteria, security implications, data-loss and migration risks, and missing tests.',
    'List concrete findings (file and reason) before your verdict.',
    'Your response MUST end with exactly one line, either:',
    'REVIEW_VERDICT: APPROVED',
    'REVIEW_VERDICT: REJECTED',
    'Reject if you found any issue that should be fixed before integration. Without a verdict line the change is treated as rejected.',
  ].join('\n');
}

export interface ReviewerCandidate {
  agent: AgentAdapter;
  score: number;
}

/**
 * Picks the healthiest, best-fit agent that did not write the change.
 * Returns undefined when no independent reviewer exists.
 */
export async function selectIndependentReviewer(
  agents: AgentAdapter[],
  excludedAgentIds: ReadonlySet<string>,
  objective: string,
): Promise<AgentAdapter | undefined> {
  const quota = AgentQuotaTracker.getInstance();
  const candidates: ReviewerCandidate[] = [];

  for (const agent of agents) {
    if (excludedAgentIds.has(agent.id)) continue;
    if (!quota.isAvailable(agent.id)) continue;
    if (!(await agent.detect())) continue;
    const capabilities = await agent.capabilities();
    if (!capabilities.canRead) continue;
    const fit = AgentFitScorer.assess(agent.id, {
      role: 'reviewer',
      requiredCapabilities: ['canRead'],
      objective,
    });
    candidates.push({ agent, score: fit.score });
  }

  // Stable: registry order breaks ties.
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.agent;
}
