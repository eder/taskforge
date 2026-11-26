import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentQuotaTracker, type AgentRegistry } from '@taskforge/agents';
import { ProcessRunner } from '@taskforge/execution';
import type { DeliveryService } from '@taskforge/integration';
import {
  EventRepository,
  RunRepository,
  TaskRepository,
  type TaskForgeDatabase,
} from '@taskforge/persistence';
import { describeRunFailures } from '@taskforge/scheduler';
import { deleteProjectConfigKey, type TaskForgeConfig } from '@taskforge/shared';
import { getNextPendingWave, loadLivingPlan } from './living-plan.js';

export type NodePackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export interface WorkspaceDependencyStatus {
  hasPackageJson: boolean;
  hasDependencies: boolean;
  hasNodeModules: boolean;
  missingNodeModules: boolean;
  packageManager: NodePackageManager;
  checkScripts: string[];
}

export interface WorkspaceBootstrapResult {
  installed: boolean;
  installCommand?: string;
  installError?: string;
  upgradedVerification: boolean;
  notes: string[];
}

export interface WorkspaceBootstrapOptions {
  /** Custom command runner for deterministic unit tests (defaults to ProcessRunner.run). */
  runInstall?: (
    command: string,
    args: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  onProgress?: (line: string) => void;
  /** Allows running real install even when VITEST=true (off by default to keep tests fast/offline). */
  allowInstallInTests?: boolean;
}

const GREENFIELD_PLACEHOLDER_CHECKS = new Set([
  'git diff --check',
  'git status',
  'true',
]);

/** Detects the Node package manager and whether dependencies/check scripts are present in `repoRoot`. */
export function inspectWorkspaceDependencies(repoRoot: string): WorkspaceDependencyStatus {
  const pkgPath = path.join(repoRoot, 'package.json');
  const hasPackageJson = fs.existsSync(pkgPath);
  const hasNodeModules = fs.existsSync(path.join(repoRoot, 'node_modules'));

  let packageManager: NodePackageManager = 'npm';
  if (fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (fs.existsSync(path.join(repoRoot, 'yarn.lock'))) packageManager = 'yarn';
  else if (fs.existsSync(path.join(repoRoot, 'bun.lockb'))) packageManager = 'bun';
  else if (fs.existsSync(path.join(repoRoot, 'package-lock.json'))) packageManager = 'npm';

  let hasDependencies = false;
  const checkScripts: string[] = [];

  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        packageManager?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      if (
        typeof pkg.packageManager === 'string' &&
        !fs.existsSync(path.join(repoRoot, 'package-lock.json'))
      ) {
        if (pkg.packageManager.startsWith('pnpm')) packageManager = 'pnpm';
        else if (pkg.packageManager.startsWith('yarn')) packageManager = 'yarn';
        else if (pkg.packageManager.startsWith('bun')) packageManager = 'bun';
      }
      hasDependencies =
        Object.keys(pkg.dependencies ?? {}).length > 0 ||
        Object.keys(pkg.devDependencies ?? {}).length > 0;
      const scripts = pkg.scripts ?? {};
      for (const name of ['test', 'lint', 'typecheck']) {
        if (typeof scripts[name] === 'string' && scripts[name].trim().length > 0) {
          checkScripts.push(name);
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }

  return {
    hasPackageJson,
    hasDependencies,
    hasNodeModules,
    missingNodeModules: hasPackageJson && hasDependencies && !hasNodeModules,
    packageManager,
    checkScripts,
  };
}

/** True when `verification.commands` only contains a temporary greenfield placeholder like `git diff --check`. */
export function isPlaceholderVerificationConfig(commands?: string[]): boolean {
  if (!commands || commands.length === 0) return false;
  return commands.every((cmd) => GREENFIELD_PLACEHOLDER_CHECKS.has(cmd.trim().toLowerCase()));
}

/**
 * Automatically bootstraps host dependencies when an applied run introduces
 * `package.json` without `node_modules` (since sandboxed agents often cannot
 * access the network), and upgrades temporary `git diff --check` verification
 * back to auto-discovered `package.json` scripts once dependencies are ready.
 */
export async function bootstrapWorkspaceAfterApply(
  repoRoot: string,
  config: TaskForgeConfig,
  options: WorkspaceBootstrapOptions = {},
): Promise<WorkspaceBootstrapResult> {
  const status = inspectWorkspaceDependencies(repoRoot);
  const notes: string[] = [];
  let installed = false;
  let installCommand: string | undefined;
  let installError: string | undefined;
  let upgradedVerification = false;

  if (status.missingNodeModules) {
    const policy = config.permissions?.commands?.package_install ?? 'ask_human';
    installCommand = `${status.packageManager} install`;

    if (policy === 'deny') {
      notes.push(
        `package.json has dependencies but node_modules is missing (auto-install disabled by permissions.commands.package_install: deny). Run \`${installCommand}\` manually.`,
      );
    } else if (process.env.VITEST && !options.allowInstallInTests && !options.runInstall) {
      notes.push(`Skipped automatic \`${installCommand}\` during test execution.`);
    } else {
      options.onProgress?.(`Installing project dependencies on host (${installCommand})...`);
      const runner =
        options.runInstall ??
        (async (cmd: string, args: string[], cwd: string) =>
          ProcessRunner.run({ command: cmd, args, cwd, timeoutMs: 180_000 }));
      try {
        const res = await runner(status.packageManager, ['install'], repoRoot);
        if (res.exitCode === 0) {
          installed = true;
          notes.push(`Installed project dependencies automatically via \`${installCommand}\`.`);
        } else {
          const tail = `${res.stderr ?? ''}\n${res.stdout ?? ''}`
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-2)
            .join(' | ');
          installError = tail || `exit code ${res.exitCode}`;
          notes.push(
            `Automatic \`${installCommand}\` failed (${installError}). Run \`${installCommand}\` manually to populate node_modules.`,
          );
        }
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
        notes.push(
          `Automatic \`${installCommand}\` failed (${installError}). Run \`${installCommand}\` manually.`,
        );
      }
    }
  }

  // Once package.json has real check scripts AND node_modules exists, remove any temporary
  // greenfield `git diff --check` override so VerificationRunner runs real test/lint/typecheck.
  const nodeModulesNowPresent = status.hasNodeModules || installed || fs.existsSync(path.join(repoRoot, 'node_modules'));
  if (
    status.hasPackageJson &&
    status.checkScripts.length > 0 &&
    nodeModulesNowPresent &&
    isPlaceholderVerificationConfig(config.verification.commands)
  ) {
    try {
      deleteProjectConfigKey(repoRoot, ['verification', 'commands']);
    } catch {
      // best-effort when .taskforge/config.yaml doesn't exist
    }
    config.verification.commands = [];
    upgradedVerification = true;
    notes.push(
      `Upgraded verification checks from placeholder \`git diff --check\` to auto-discovered package.json scripts (${status.checkScripts.join(', ')}).`,
    );
  }

  return {
    installed,
    installCommand,
    installError,
    upgradedVerification,
    notes,
  };
}

export interface ControlPlaneSnapshotInput {
  repoRoot: string;
  config: TaskForgeConfig;
  db: TaskForgeDatabase;
  deliveryService: DeliveryService;
  agentRegistry: AgentRegistry;
  currentBranch?: string;
}

export interface ControlPlaneSnapshot {
  readyRuns: Array<{ runId: string; branch: string; targetBranch: string; goal?: string }>;
  failedRuns: Array<{ runId: string; summary: string }>;
  livingPlanSummary?: string;
  degradedAgents: string[];
  environmentIssues: string[];
}

/**
 * Collects a compact, authoritative snapshot of TaskForge's live control-plane
 * state (pending deliveries, failed runs & causes, Living Plan progress,
 * degraded agents, and workspace dependency/verification gaps).
 */
export function collectControlPlaneSnapshot(input: ControlPlaneSnapshotInput): ControlPlaneSnapshot {
  const { repoRoot, config, db, deliveryService, agentRegistry } = input;
  const runRepo = new RunRepository(db);
  const taskRepo = new TaskRepository(db);
  const eventRepo = new EventRepository(db);

  const allRuns = runRepo.listAll();
  const readyRuns: ControlPlaneSnapshot['readyRuns'] = [];
  for (const run of allRuns.slice(0, 10)) {
    const delivery = deliveryService.getDelivery(run.id);
    if (delivery?.status === 'ready_to_apply') {
      readyRuns.push({
        runId: run.id,
        branch: delivery.branch,
        targetBranch: delivery.targetBranch,
      });
    }
  }

  const failedRuns: ControlPlaneSnapshot['failedRuns'] = [];
  for (const run of allRuns.slice(0, 5)) {
    if (run.status !== 'failed') continue;
    const failures = describeRunFailures({ taskRepo, eventRepo }, run.id);
    const active = failures.filter((f) => f.kind !== 'not_started');
    const summary =
      active.length > 0
        ? active
            .slice(0, 2)
            .map((f) => {
              const detail = f.scopeViolations?.length
                ? `scope violation (${f.scopeViolations.slice(0, 3).join(', ')})`
                : (f.reason ?? f.failureClass ?? 'failed').slice(0, 120);
              return `${f.taskId} [${f.kind}]: ${detail}`;
            })
            .join('; ')
        : 'failed (see /inspect)';
    failedRuns.push({ runId: run.id, summary });
  }

  let livingPlanSummary: string | undefined;
  const plan = loadLivingPlan(repoRoot);
  if (plan) {
    const waveSummary = plan.waves
      .map((w) => `W${w.number}:${w.status}${w.runId ? `(${w.runId})` : ''}`)
      .join(', ');
    const next = getNextPendingWave(plan);
    livingPlanSummary = `"${plan.title}" [${waveSummary}]${next ? ` · next=Wave ${next.number} (${next.mode})` : ' · all waves complete'}`;
  }

  const degradedAgents: string[] = [];
  const quotaTracker = AgentQuotaTracker.getInstance();
  for (const agent of agentRegistry.list()) {
    if (agent.id === 'fake') continue;
    const status = quotaTracker.getQuotaStatus(agent.id);
    if (status.status !== 'ready') {
      degradedAgents.push(`${agent.id}: ${status.status}${status.reason ? ` (${status.reason.slice(0, 80)})` : ''}`);
    }
  }

  const environmentIssues: string[] = [];
  const depStatus = inspectWorkspaceDependencies(repoRoot);
  if (depStatus.missingNodeModules) {
    environmentIssues.push(
      `package.json exists with dependencies but node_modules is missing (run \`${depStatus.packageManager} install\`).`,
    );
  }
  if (
    depStatus.hasPackageJson &&
    depStatus.checkScripts.length > 0 &&
    isPlaceholderVerificationConfig(config.verification.commands)
  ) {
    environmentIssues.push(
      `verification.commands is still set to placeholder \`git diff --check\` even though package.json defines: ${depStatus.checkScripts.join(', ')}.`,
    );
  }

  return {
    readyRuns,
    failedRuns,
    livingPlanSummary,
    degradedAgents,
    environmentIssues,
  };
}

/**
 * Formats the control-plane snapshot into a compact supervisor context block
 * injected into Direct Mode / Smart Auto-Dispatch turns so agents can accurately
 * diagnose TaskForge runs, unapplied deliveries, Living Plan progress, and setup gaps.
 */
export function formatControlPlaneContextForPrompt(
  snapshot: ControlPlaneSnapshot,
  maxChars = 1600,
): string | undefined {
  const lines: string[] = [];
  if (snapshot.livingPlanSummary) {
    lines.push(`- Living Plan (.taskforge/plan.md): ${snapshot.livingPlanSummary}`);
  }
  if (snapshot.readyRuns.length > 0) {
    const list = snapshot.readyRuns
      .slice(0, 3)
      .map((r) => `${r.runId} (branch ${r.branch} → ${r.targetBranch}, unapplied — use \`/apply ${r.runId}\`)`)
      .join('; ');
    lines.push(`- Unapplied READY TO APPLY runs: ${list}`);
  }
  if (snapshot.failedRuns.length > 0) {
    const list = snapshot.failedRuns
      .slice(0, 2)
      .map((r) => `${r.runId}: ${r.summary}`)
      .join(' | ');
    lines.push(`- Recent failed runs: ${list}`);
  }
  if (snapshot.degradedAgents.length > 0) {
    lines.push(`- Degraded/unavailable agents: ${snapshot.degradedAgents.join(', ')}`);
  }
  if (snapshot.environmentIssues.length > 0) {
    for (const issue of snapshot.environmentIssues) {
      lines.push(`- Environment issue: ${issue}`);
    }
  }
  if (lines.length === 0) return undefined;

  const block = [
    '[TaskForge Control-Plane State — authoritative runtime context]',
    ...lines,
    'Use this control-plane state when the user asks why a run stopped, what is unapplied, what remains to be done, or how to proceed (mention exact `/apply <runId>`, `/fix`, `/blueprint next`, or Enter actions when relevant).',
  ].join('\n');

  return block.length > maxChars ? `${block.slice(0, maxChars - 1)}…` : block;
}
