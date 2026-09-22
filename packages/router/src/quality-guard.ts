import { isLightweightReadOnlyRequest } from '@taskforge/shared';
import {
  RoutingDecision,
  RoutingInput,
  PolicyAdjustment,
  RouterProposal,
} from './router-types.js';

export class RouterQualityGuard {
  private static readonly DOMAIN_SIGNALS = [
    {
      category: 'concurrency',
      pattern: /\b(concurrency|concurrency slots?|race condition|deadlock|mutex|lock|contention)\b/i,
      label: 'concurrency and thread/slot contention',
    },
    {
      category: 'process_lifecycle',
      pattern: /\b(process lifecycle|child_process|child process|stdin|stdout|stderr|eof|spawn|sigint|sigterm)\b/i,
      label: 'process lifecycle and stdio semantics',
    },
    {
      category: 'git_internals',
      pattern: /\b(worktrees?|cherry-pick|git-workflow|merge conflict|branching|refs?)\b/i,
      label: 'git worktrees and repository branch lifecycle',
    },
    {
      category: 'session_communication',
      pattern: /\b(session routing|session registry|communication ?bus|message bus|session lifecycle)\b/i,
      label: 'cross-agent communication and session routing',
    },
    {
      category: 'multi_agent_orchestration',
      pattern: /\b(multi-agent|maxagentspertask|emergent collaboration|independent review|failover|staffing)\b/i,
      label: 'multi-agent orchestration and governance',
    },
    {
      category: 'multi_package_runtime',
      pattern: /\b(runtime hardening|self-hosting|cross-package|monorepo architecture|delivery gate)\b/i,
      label: 'cross-package runtime hardening architecture',
    },
  ];

  /**
   * Deterministic guardrail to ensure complex, cross-cutting runtime refactors
   * are not erroneously classified as low complexity / low risk.
   */
  public static evaluate(
    proposal: RoutingDecision,
    input: RoutingInput,
  ): RoutingDecision {
    const text = [
      input.task.title,
      input.task.description,
      input.task.contract.objective,
      ...(input.task.contract.acceptanceCriteria ?? []),
    ].join(' ');

    // Read-only summaries/explanations are investigations in the task model,
    // but they are not "high uncertainty" engineering investigations. Keep
    // them deliberately cheap and low-latency even if an adaptive/model router
    // over-staffs them.
    const isReadOnly =
      input.task.contract.completionMode === 'report' ||
      input.task.contract.forbiddenChanges?.includes('*');
    const invariantLightweightReadOnly =
      input.task.contract.metadata?.lightweightReadOnlyInvariant === true;
    const lightweightReadOnly =
      isReadOnly &&
      input.task.type === 'investigation' &&
      (invariantLightweightReadOnly ||
        (isLightweightReadOnlyRequest(text) &&
          !/\b(root cause|reproduce|reproduction|bug|flaky|race|deadlock|incident|failure|security|audit|vulnerab|payment|pagamento|auth|inconsisten|corrupt)\b/i.test(text)));

    if (lightweightReadOnly) {
      return {
        strategy: 'single',
        complexity: 'low',
        risk: 'low',
        uncertainty: 'low',
        teamSize: 1,
        roles: [
          {
            role: 'researcher',
            requiredCapabilities: ['canRead'],
            objective: input.task.contract.objective,
          },
        ],
        communication: {
          required: false,
          initialAlignment: false,
          synthesisBeforeImplementation: false,
        },
        reason: 'Lightweight read-only repository analysis: one agent is sufficient.',
        source: proposal.source,
        provenance: proposal.provenance,
      };
    }

    const textForSignals = text;

    const matchedReasons: string[] = [];
    for (const signal of this.DOMAIN_SIGNALS) {
      if (signal.pattern.test(textForSignals)) {
        matchedReasons.push(signal.label);
      }
    }

    // Also check if task touches multiple packages
    const packageMentions = [
      'scheduler',
      'agents',
      'operator',
      'conversation',
      'core',
      'persistence',
      'router',
      'workspace',
      'verification',
    ].filter((pkg) => new RegExp(`\\b${pkg}\\b`, 'i').test(textForSignals));

    if (packageMentions.length >= 2) {
      matchedReasons.push(`crosses multiple packages: ${packageMentions.join(', ')}`);
    }

    // Only apply guardrail adjustment if significant cross-cutting signals are present
    if (matchedReasons.length < 2) {
      return proposal;
    }

    const adjustedComplexity = 'high' as const;
    const adjustedRisk = 'high' as const;

    const changed =
      adjustedComplexity !== proposal.complexity || adjustedRisk !== proposal.risk;

    if (!changed) {
      return proposal;
    }

    const routerProposal: RouterProposal = {
      strategy: proposal.strategy,
      complexity: proposal.complexity,
      risk: proposal.risk,
    };

    const policyAdjustment: PolicyAdjustment = {
      originalComplexity: proposal.complexity,
      adjustedComplexity,
      originalRisk: proposal.risk,
      adjustedRisk,
      reasons: matchedReasons,
      crossCuttingRuntimeUpgrade: true,
    };

    return {
      ...proposal,
      complexity: adjustedComplexity,
      risk: adjustedRisk,
      routerProposal,
      policyAdjustment,
      provenance: {
        ...(proposal.provenance ?? { source: proposal.source }),
        routerProposal,
        policyAdjustment,
      },
    };
  }

  public static evaluateTask(task: import('@taskforge/core').Task): {
    isCrossCuttingRuntime: boolean;
    shouldUpgrade: boolean;
    recommendedComplexity: 'high';
    recommendedRisk: 'high';
    matchedReasons: string[];
  } {
    const text = [
      task.title,
      task.description,
      task.contract.objective,
      ...(task.contract.acceptanceCriteria ?? []),
    ].join(' ');

    const matchedReasons: string[] = [];
    for (const signal of this.DOMAIN_SIGNALS) {
      if (signal.pattern.test(text)) {
        matchedReasons.push(signal.label);
      }
    }

    const isCrossCutting = matchedReasons.length > 0;
    return {
      isCrossCuttingRuntime: isCrossCutting,
      shouldUpgrade: isCrossCutting,
      recommendedComplexity: 'high',
      recommendedRisk: 'high',
      matchedReasons,
    };
  }
}

export const RoutingQualityGuard = RouterQualityGuard;
export type RoutingQualityGuard = RouterQualityGuard;
