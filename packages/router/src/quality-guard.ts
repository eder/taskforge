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

    let guarded = proposal;

    // Apply cross-cutting upgrade when the task spans multiple runtime concerns.
    if (matchedReasons.length >= 2) {
      const adjustedComplexity = 'high' as const;
      const adjustedRisk = 'high' as const;
      const changed =
        adjustedComplexity !== proposal.complexity || adjustedRisk !== proposal.risk;

      if (changed) {
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

        guarded = {
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
    }

    return this.enforceFanOutAdmission(guarded);
  }

  /**
   * Fan-out is not a feature by itself. Admit more than one role only when the
   * proposed team has observable structural evidence for either:
   *   - parallelizable, non-duplicate objectives; or
   *   - an explicit specialist quality role paired with primary execution.
   *
   * Complexity alone is not sufficient. This prevents model/router enthusiasm
   * from multiplying full-repository reads that do not improve time or quality.
   */
  private static enforceFanOutAdmission(proposal: RoutingDecision): RoutingDecision {
    const requestedFanOut =
      proposal.teamSize > 1 ||
      proposal.roles.length > 1 ||
      proposal.strategy !== 'single';

    if (!requestedFanOut || proposal.roles.length <= 1) {
      return proposal;
    }

    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const objectives = proposal.roles.map((role) => normalize(role.objective));
    const distinctObjectives = new Set(objectives.filter(Boolean));
    const distinctRoles = new Set(proposal.roles.map((role) => role.role));
    const qualityRoles = new Set([
      'reviewer',
      'critic',
      'tester',
      'security_reviewer',
      'architecture_reviewer',
    ]);

    const hasQualityRole = proposal.roles.some((role) => qualityRoles.has(role.role));
    const hasPrimaryRole = proposal.roles.some((role) => !qualityRoles.has(role.role));
    const hasDistinctWork =
      distinctObjectives.size >= 2 &&
      distinctObjectives.size >= Math.ceil(proposal.roles.length / 2);

    const timeCase =
      hasDistinctWork &&
      ['parallel', 'partitioned', 'competitive', 'collaborative'].includes(proposal.strategy);
    const qualityCase = hasQualityRole && hasPrimaryRole;
    const complementaryHighRiskCase =
      proposal.risk === 'high' &&
      hasDistinctWork &&
      distinctRoles.size >= 2;

    const benefits: import('./router-types.js').FanOutBenefit[] = [];
    const reasons: string[] = [];
    if (timeCase) {
      benefits.push('parallel_work');
      reasons.push('roles have sufficiently distinct objectives that can execute independently');
    }
    if (qualityCase) {
      benefits.push('quality_guard');
      reasons.push('team includes a specialist quality role paired with primary execution');
    }
    if (complementaryHighRiskCase) {
      benefits.push('complementary_high_risk');
      reasons.push('high-risk work has distinct complementary roles and objectives');
    }

    if (benefits.length > 0) {
      return {
        ...proposal,
        fanOutAssessment: {
          requested: true,
          admitted: true,
          requestedTeamSize: proposal.teamSize,
          admittedTeamSize: proposal.roles.length,
          benefits,
          reasons,
        },
      };
    }

    const primary = proposal.roles[0];
    return {
      ...proposal,
      strategy: 'single',
      teamSize: 1,
      roles: [primary],
      communication: {
        required: false,
        initialAlignment: false,
        synthesisBeforeImplementation: false,
      },
      reason:
        `Fan-out rejected by efficiency policy: proposed roles did not demonstrate distinct parallel work or a specialist quality guard. Original reason: ${proposal.reason}`,
      fanOutAssessment: {
        requested: true,
        admitted: false,
        requestedTeamSize: proposal.teamSize,
        admittedTeamSize: 1,
        benefits: [],
        reasons: [
          'proposed roles did not demonstrate distinct parallel work',
          'no specialist quality guard justified additional provider cost',
        ],
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
