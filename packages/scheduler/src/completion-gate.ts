import { Task } from '@taskforge/core';
import {
  AgentAssignment,
  AgentResult,
  CompletionGateResult,
  CompletionFailureReason,
  CompletionEvidence,
  ProviderExecutionOutcome,
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
    if (task.type === 'implementation') {
      // Implementation MUST produce code changes or commits.
      // Green preexisting tests CANNOT make a zero-work implementation pass!
      if (commitsProduced.length === 0 && filesModified.length === 0) {
        return {
          accepted: false,
          failureReason: 'NO_CHANGES_PRODUCED',
          evidence: {
            filesModified: [],
            commitsProduced: [],
            verificationPassed: ctx.verificationPassed,
            explanation: `Implementation task '${task.id}' produced zero file modifications and zero git commits against base commit ${baseCommit?.slice(0, 7) ?? 'unknown'}. Pre-existing test results cannot substitute for required code changes.`,
          },
        };
      }
    } else if (task.type === 'investigation') {
      // Investigation does NOT require git commits, but requires a substantive report
      const outputText = (agentResult.output ?? agentResult.message ?? '').trim();
      if (outputText.length < 20) {
        return {
          accepted: false,
          failureReason: 'EMPTY_PROVIDER_RESULT',
          evidence: {
            investigationReportLength: outputText.length,
            explanation: `Investigation task '${task.id}' produced insufficient or empty analysis output (${outputText.length} chars).`,
          },
        };
      }
    } else if (task.type === 'review') {
      // Review does NOT require git commits, but requires findings or substantive commentary
      const findings = agentResult.findings ?? [];
      const outputText = (agentResult.output ?? agentResult.message ?? '').trim();
      if (findings.length === 0 && outputText.length < 20) {
        return {
          accepted: false,
          failureReason: 'EMPTY_PROVIDER_RESULT',
          evidence: {
            reviewFindingsCount: 0,
            explanation: `Review task '${task.id}' produced no review findings or analysis report.`,
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
