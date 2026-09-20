import { Task } from '@taskforge/core';
import {
  AgentAssignment,
  AgentResult,
  CompletionGateResult,
  CompletionEvidence,
  ProviderExecutionOutcome,
  TaskType,
} from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';

/**
 * Sanitizes task output to ensure raw JSON or JSONL blobs are never returned
 * or displayed as user-facing analysis / explanations.
 */
export function sanitizeTaskOutput(output?: string): string {
  if (!output) return '';
  const trimmed = output.trim();
  const lines = trimmed.split('\n');
  const extractedLines: string[] = [];

  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('{') && l.endsWith('}')) {
      try {
        const parsed = JSON.parse(l);
        if (typeof parsed.response === 'string' && parsed.response) {
          extractedLines.push(parsed.response);
        } else if (typeof parsed.finalResponse === 'string' && parsed.finalResponse) {
          extractedLines.push(parsed.finalResponse);
        } else if (typeof parsed.output === 'string' && parsed.output) {
          extractedLines.push(parsed.output);
        } else if (typeof parsed.message === 'string' && parsed.message) {
          extractedLines.push(parsed.message);
        } else if (typeof parsed.text === 'string' && parsed.text) {
          extractedLines.push(parsed.text);
        } else if (parsed.message && typeof parsed.message === 'object') {
          if (typeof parsed.message.content === 'string' && parsed.message.content) {
            extractedLines.push(parsed.message.content);
          } else if (Array.isArray(parsed.message.content)) {
            const texts = parsed.message.content
              .filter((c: any) => c && typeof c.text === 'string')
              .map((c: any) => c.text);
            if (texts.length > 0) {
              extractedLines.push(texts.join('\n'));
            }
          }
        }
        // If it's a structural or system envelope without readable content, discard it
        continue;
      } catch {
        extractedLines.push(line);
      }
    } else {
      extractedLines.push(line);
    }
  }

  return extractedLines.join('\n').trim();
}

export type CompletionRequirement =
  | 'code_change_required'
  | 'substantive_report_required'
  | 'review_findings_required';

export interface TaskCompletionPolicy {
  taskType: TaskType;
  requirement: CompletionRequirement;
  reason: string;
}

/**
 * Determines whether a testing task semantics require authoring/modifying test code vs executing tests.
 */
export function isTestingCodeTask(task: Task): boolean {
  if (task.contract?.forbiddenChanges?.includes('*')) {
    return false;
  }
  const scope = task.contract?.allowedScope ?? [];
  const text = `${task.contract?.objective ?? ''} ${task.title} ${task.description}`.toLowerCase();

  const authoringPatterns = [
    /\b(write|add|create|implement|author|introduce|scaffold|generate|update|modify|refactor)\b.*\b(tests?|specs?|fixtures?|suites?)\b/i,
    /\b(new tests?|unit tests?|integration tests?|regression tests?|e2e tests?|acceptance tests?)\b/i,
    /\btest coverage\b/i,
  ];
  if (authoringPatterns.some((p) => p.test(text))) {
    return true;
  }

  const executionPatterns = [
    /\b(run|execute|verify|validate|check|assert|inspect)\b.*\b(tests?|suite|regression|criteria|verification)\b/i,
    /\bverify all\b/i,
  ];
  if (executionPatterns.some((p) => p.test(text))) {
    return false;
  }

  return scope.length > 0 && !scope.every((s) => s === '');
}

/**
 * Determines whether an architecture task semantics require authoring code structure vs design/ADR evidence.
 */
export function isArchitectureCodeTask(task: Task): boolean {
  if (task.contract?.forbiddenChanges?.includes('*')) {
    return false;
  }
  const scope = task.contract?.allowedScope ?? [];
  if (scope.length === 0) {
    return false;
  }

  const text = `${task.contract?.objective ?? ''} ${task.title} ${task.description}`.toLowerCase();

  const scaffoldingPatterns = [
    /\b(scaffold|bootstrap|setup|create files?|initialize|skeleton|structure|workspace|directory structure)\b/i,
  ];
  if (scaffoldingPatterns.some((p) => p.test(text))) {
    return true;
  }

  const designPatterns = [
    /\b(design|adr|rfc|proposal|blueprint|specification|spec|audit|diagram|analyze|document)\b/i,
  ];
  if (designPatterns.some((p) => p.test(text))) {
    return false;
  }

  return scope.length > 0;
}

/**
 * Resolves the completion policy for a given task using an explicit exhaustive switch over TaskType.
 */
export function resolveCompletionPolicy(task: Task): TaskCompletionPolicy {
  switch (task.type) {
    case 'implementation':
      return {
        taskType: 'implementation',
        requirement: 'code_change_required',
        reason: 'Implementation tasks require file modifications or git commits.',
      };

    case 'refactoring':
      return {
        taskType: 'refactoring',
        requirement: 'code_change_required',
        reason: 'Refactoring tasks require file modifications or git commits without changing external behavior.',
      };

    case 'investigation':
      return {
        taskType: 'investigation',
        requirement: 'substantive_report_required',
        reason: 'Investigation tasks require a substantive analysis report.',
      };

    case 'review':
      return {
        taskType: 'review',
        requirement: 'review_findings_required',
        reason: 'Review tasks require structured findings or substantive review commentary.',
      };

    case 'testing': {
      const isCode = isTestingCodeTask(task);
      return {
        taskType: 'testing',
        requirement: isCode ? 'code_change_required' : 'substantive_report_required',
        reason: isCode
          ? 'Testing task requires authoring or modifying test files.'
          : 'Testing task requires test execution evidence and verification results.',
      };
    }

    case 'architecture': {
      const isCode = isArchitectureCodeTask(task);
      return {
        taskType: 'architecture',
        requirement: isCode ? 'code_change_required' : 'substantive_report_required',
        reason: isCode
          ? 'Architecture scaffolding task requires creating or modifying code structure.'
          : 'Architecture design task requires substantive design documentation or ADR report.',
      };
    }

    default: {
      const _exhaustiveCheck: never = task.type;
      throw new Error(`Unhandled TaskType in CompletionGate policy: ${_exhaustiveCheck}`);
    }
  }
}

export interface CompletionGateContext {
  task: Task;
  assignment?: AgentAssignment;
  agentResult: AgentResult;
  normalizedOutcome?: ProviderExecutionOutcome;
  baseCommit?: string;
  resultingCommit?: string;
  worktreePath?: string;
  verificationPassed?: boolean;
  gitService?: GitService;
}

export class CompletionGate {
  constructor(private defaultGitService?: GitService) {}

  /**
   * Evaluates whether an agent execution actually accomplished the assigned task,
   * enforcing deterministic completion invariants beyond simple process exit codes.
   */
  async evaluate(ctx: CompletionGateContext): Promise<CompletionGateResult> {
    const { task, agentResult } = ctx;
    const normalizedOutcome = ctx.normalizedOutcome ?? agentResult.normalizedOutcome;

    // 1. Check for denied actions (e.g. Antigravity or Codex requested RunCommand / EditFile but was denied)
    const deniedActions = normalizedOutcome?.deniedActions ?? [];
    if (deniedActions.length > 0 || agentResult.completionReason === 'REQUIRED_ACTION_DENIED') {
      return {
        accepted: false,
        failureReason: 'REQUIRED_ACTION_DENIED',
        evidence: {
          actionsDenied: deniedActions,
          deniedActions,
          explanation:
            deniedActions.length > 0
              ? `Agent requested required actions that were denied by permission policy: ${deniedActions.map((d) => `${d.action} (${d.tool})`).join(', ')}`
              : 'Required agent action was denied by policy.',
        },
      };
    }

    // 2. Check for unresolved interaction
    if (agentResult.completionReason === 'UNRESOLVED_INTERACTION') {
      return {
        accepted: false,
        failureReason: 'UNRESOLVED_INTERACTION',
        evidence: {
          explanation: 'Agent execution terminated with unresolved user interactions.',
        },
      };
    }

    // 3. Check for empty provider result
    if (agentResult.completionReason === 'EMPTY_PROVIDER_RESULT') {
      return {
        accepted: false,
        failureReason: 'EMPTY_PROVIDER_RESULT',
        evidence: {
          explanation: 'Agent provider returned an empty execution result.',
        },
      };
    }

    // 4. Check for harness failure
    if (!agentResult.success || agentResult.completionReason === 'HARNESS_FAILED') {
      return {
        accepted: false,
        failureReason: agentResult.completionReason ?? 'HARNESS_FAILED',
        evidence: {
          explanation: agentResult.message || 'Agent harness failed execution.',
        },
      };
    }

    // 5. Gather git changes and commits
    const git = ctx.gitService ?? this.defaultGitService;
    const filesModified: string[] = [];
    const commitsProduced: string[] = [];
    const baseCommit = ctx.baseCommit;
    let resultingCommit = ctx.resultingCommit ?? agentResult.commitHash;

    if (git && ctx.worktreePath) {
      try {
        const status = await git.getStatus(ctx.worktreePath);
        for (const file of status.uncommittedFiles) {
          if (!filesModified.includes(file)) {
            filesModified.push(file);
          }
        }
        if (!resultingCommit && status.headCommit && status.headCommit !== 'EMPTY_TREE') {
          resultingCommit = status.headCommit;
        }
      } catch {
        // Fall back to reported commitHash if worktree git status fails
      }

      if (baseCommit && resultingCommit && resultingCommit !== baseCommit) {
        try {
          commitsProduced.push(resultingCommit);
          const diffOut = await git.exec(['diff', '--name-only', baseCommit, resultingCommit], ctx.worktreePath);
          const files = diffOut
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          for (const f of files) {
            if (!filesModified.includes(f)) {
              filesModified.push(f);
            }
          }
        } catch {
          // git diff failed or worktree removed
        }
      }
    }

    if (resultingCommit && baseCommit && resultingCommit !== baseCommit && !commitsProduced.includes(resultingCommit)) {
      commitsProduced.push(resultingCommit);
    }

    // 6. Task-type specific completion invariants
    const policy = resolveCompletionPolicy(task);

    if (policy.requirement === 'code_change_required') {
      // Implementation / Refactoring / Test authoring / Scaffolding MUST produce code changes or commits.
      if (commitsProduced.length === 0 && filesModified.length === 0) {
        return {
          accepted: false,
          failureReason: 'NO_CHANGES_PRODUCED',
          evidence: {
            filesModified: [],
            commitsProduced: [],
            verificationPassed: ctx.verificationPassed,
            explanation: `${task.type.toUpperCase()} task '${task.id}' produced zero file modifications and zero git commits against base commit ${baseCommit?.slice(0, 7) ?? 'unknown'}. ${policy.reason}`,
          },
        };
      }
    } else if (policy.requirement === 'substantive_report_required') {
      // Investigation / Test verification / Design evidence requires a substantive report
      const outputText = sanitizeTaskOutput(agentResult.output ?? agentResult.message ?? '').trim();
      if (outputText.length < 20) {
        return {
          accepted: false,
          failureReason: 'EMPTY_PROVIDER_RESULT',
          evidence: {
            investigationReportLength: outputText.length,
            explanation: `${task.type.toUpperCase()} task '${task.id}' produced insufficient or empty analysis output (${outputText.length} chars). ${policy.reason}`,
          },
        };
      }
    } else if (policy.requirement === 'review_findings_required') {
      // Review does NOT require git commits, but requires findings or substantive commentary
      const findings = agentResult.findings ?? [];
      const outputText = sanitizeTaskOutput(agentResult.output ?? agentResult.message ?? '').trim();
      if (findings.length === 0 && outputText.length < 20) {
        return {
          accepted: false,
          failureReason: 'EMPTY_PROVIDER_RESULT',
          evidence: {
            reviewFindingsCount: 0,
            explanation: `Review task '${task.id}' produced no review findings or analysis report. ${policy.reason}`,
          },
        };
      }
    }

    // 7. Automated verification check (tests, lint, typecheck)
    if (ctx.verificationPassed === false) {
      return {
        accepted: false,
        failureReason: 'VERIFICATION_FAILED',
        evidence: {
          filesModified,
          commitsProduced,
          verificationPassed: false,
          explanation: 'Automated verification failed for the changes produced.',
        },
      };
    }

    // All completion criteria satisfied
    const evidence: CompletionEvidence = {
      filesModified,
      commitsProduced,
      reviewFindingsCount: agentResult.findings?.length,
      investigationReportLength: (agentResult.output ?? '').trim().length,
      verificationPassed: ctx.verificationPassed ?? true,
      explanation: `Completion gate accepted task '${task.id}' with verified evidence.`,
    };

    return {
      accepted: true,
      evidence,
    };
  }
}
