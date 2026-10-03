import {
  environmentFixesFor,
  environmentHint,
  describeFix,
  refusedPort,
  type RunFailureLine,
} from '@taskforge/scheduler';

/**
 * When a run stops, the REPL "enters" it: it says in plain words what stopped
 * the run, proposes the next move as something the person can accept with Enter,
 * or asks the one thing it needs, and whatever the person types next goes to
 * that run. This module decides that proposal; it is deterministic and reads
 * only what the run recorded.
 */
export type FocusAction =
  /** Repair what blocked the run (see environment-repair.ts), then continue it. */
  | { kind: 'fix' }
  /** Continue the run (the agent picks up its kept work, or the checks re-run). */
  | { kind: 'continue' }
  /** The run stopped at its token cap: raise it and continue. */
  | { kind: 'raise_budget'; budget: number }
  /** Nothing TaskForge can do on its own; only a way to get out of the run. */
  | { kind: 'none' };

/** Something TaskForge needs from the person; their next message answers it. */
export type FocusQuestion =
  | { kind: 'start_command'; port: number }
  | { kind: 'check_command' };

export interface RunFocus {
  runId: string;
  action: FocusAction;
  question?: FocusQuestion;
  /** What the person asked for while a repair was waiting; given to the agents after it. */
  guidance?: string;
  /** The run is already past its token cap: continuing needs this higher cap or it would stop at once. */
  raiseBudgetTo?: number;
}

export interface FocusProposal {
  focus: RunFocus;
  /** The sentences shown to the person (plain text; the caller adds color). */
  lines: string[];
  /** Short label for the status line, e.g. "Enter: fix and continue". */
  hint: string;
}

const roundUp = (value: number, step: number) => Math.ceil(value / step) * step;
const tokens = (n: number) => n.toLocaleString('en-US');

export function buildRunFocus(options: {
  runId: string;
  failures: RunFailureLine[];
  repoRoot: string;
  spend?: { spent: number; budget: number };
}): FocusProposal {
  const proposal = proposeFocus(options);
  const { spend } = options;
  // Whatever is proposed, a run past its cap would stop again before doing it.
  if (
    spend &&
    spend.budget > 0 &&
    spend.spent >= spend.budget &&
    proposal.focus.action.kind !== 'raise_budget' &&
    proposal.focus.action.kind !== 'none'
  ) {
    const raised = roundUp(Math.max(spend.budget * 2, spend.spent + 500_000), 100_000);
    proposal.focus.raiseBudgetTo = raised;
    proposal.lines.push(
      `This run is already past its token cap (${tokens(spend.spent)} of ${tokens(spend.budget)}), so I would also raise the cap to ${tokens(raised)} tokens.`,
    );
    proposal.hint = `${proposal.hint} (and raise the cap to ${tokens(raised)})`;
  }
  return proposal;
}

function proposeFocus(options: {
  runId: string;
  failures: RunFailureLine[];
  repoRoot: string;
  spend?: { spent: number; budget: number };
}): FocusProposal {
  const { runId, failures, repoRoot, spend } = options;
  const evidence = failures
    .map((l) => l.evidence ?? l.reason ?? '')
    .join('\n');

  // 1. Stopped at the token cap: raising it is the whole fix.
  const budget = failures.find((l) => l.kind === 'budget')?.budget;
  if (budget) {
    const raised = roundUp(Math.max(budget.budget * 2, budget.spent + 100_000), 100_000);
    return {
      focus: { runId, action: { kind: 'raise_budget', budget: raised } },
      lines: [
        `It stopped at its token cap (${tokens(budget.spent)} of ${tokens(budget.budget)}). Nothing was lost.`,
        `What I'd do: raise the cap to ${tokens(raised)} tokens and continue.`,
      ],
      hint: `Enter: raise the cap to ${tokens(raised)} and continue`,
    };
  }

  // 2. A blocker TaskForge can repair on its own.
  const fixes = environmentFixesFor(failures, repoRoot);
  if (fixes.length > 0) {
    return {
      focus: { runId, action: { kind: 'fix' } },
      lines: [
        'The checks cannot run in the isolated copy, so the work could not be verified. That is not a problem with the change.',
        `What I'd do: ${fixes.map(describeFix).join('; and ')}. Then continue the run.`,
      ],
      hint: 'Enter: fix this and continue',
    };
  }

  const environment = failures.some((l) => l.failureClass === 'environment');

  // 3. A refused port with nothing to start it from: ask how.
  const port = environment ? refusedPort(evidence) : undefined;
  if (port) {
    return {
      focus: { runId, action: { kind: 'continue' }, question: { kind: 'start_command', port } },
      lines: [
        `The checks need something listening on port ${port}, and nothing is. I found no docker compose service for it.`,
        'I need one thing from you: type the command that starts it and I will run it, or start it yourself and press Enter to continue.',
      ],
      hint: `Enter: I started the service on port ${port}, continue · or type the command that starts it`,
    };
  }

  // 4. Other environment problems only the person can fix: say what, then wait.
  if (environment) {
    return {
      focus: { runId, action: { kind: 'continue' } },
      lines: [
        `${capitalize(environmentHint(failures.map((l) => l.evidence ?? l.reason ?? '')))}.`,
        'Once that is done, press Enter and I will re-check the kept work (no agent is called).',
      ],
      hint: 'Enter: done, re-check and continue',
    };
  }

  // 5. The project's check command does not work: ask which one should be used.
  if (failures.some((l) => l.failureClass === 'verification_configuration')) {
    return {
      focus: { runId, action: { kind: 'continue' }, question: { kind: 'check_command' } },
      lines: [
        'The command used to verify this project does not work, so no change can be checked.',
        'I need one thing from you: type the command that verifies this project (for example `npm test` or `pytest -q server`) and I will save it and re-check. Or fix it yourself and press Enter.',
      ],
      hint: 'Enter: fixed it, re-check · or type the command that verifies this project',
    };
  }

  // 6. Policy: a person has to decide; nothing to propose.
  if (failures.some((l) => l.failureClass === 'policy')) {
    return {
      focus: { runId, action: { kind: 'none' } },
      lines: ['A policy stopped the run. Tell me what you want changed, or /back to leave it.'],
      hint: 'type what you want · /back to leave',
    };
  }

  // 7. The work itself fell short: the agent continues from its kept work with the evidence.
  const kept = failures.some((l) => l.keptBranch);
  const costly = spend && spend.budget > 0 && spend.spent / spend.budget >= 0.5;
  const share = spend && spend.budget > 0 ? Math.round((spend.spent / spend.budget) * 100) : 0;
  return {
    focus: { runId, action: { kind: 'continue' } },
    lines: [
      kept
        ? "What I'd do: let the agent continue from the work it kept, with the failure evidence."
        : "What I'd do: keep what was integrated and run the rest again.",
      ...(costly ? [`This run already used ${share}% of its token budget, so continuing spends more.`] : []),
    ],
    hint: 'Enter: continue',
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
