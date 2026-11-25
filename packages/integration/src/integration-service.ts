import { GitService, WorktreeManager } from '@taskforge/workspace';
import { EventRepository } from '@taskforge/persistence';
import { VerificationRunner, isDocumentationOnlyChange } from '@taskforge/verification';
import { IntegrationError, TaskForgeConfig } from '@taskforge/shared';
import { integrationBranchName } from './branch-naming.js';

export interface IntegrateTaskOptions {
  runId: string;
  taskId: string;
  commitHash: string;
  baseCommit: string;
}

export class IntegrationService {
  constructor(
    private repoRoot: string,
    private gitService: GitService,
    private worktreeManager: WorktreeManager,
    private verificationRunner?: VerificationRunner,
    private eventRepo?: EventRepository,
  ) {}

  /** Per-run: one service instance may serve several runs (and resumes). */
  private branchInitPromises = new Map<string, Promise<string>>();
  private queueLock: Promise<void> = Promise.resolve();

  getBranchName(runId: string): string {
    return integrationBranchName(runId);
  }

  async initIntegrationBranch(runId: string, baseCommit: string): Promise<string> {
    const branchName = this.getBranchName(runId);
    const cached = this.branchInitPromises.get(runId);
    if (cached) {
      await cached;
      // The branch may have been deleted since (for example by a cleanup);
      // trusting the cache would leave worktree creation pointing at nothing.
      if (await this.gitService.branchExists(branchName)) return branchName;
      this.branchInitPromises.delete(runId);
    }

    const init = (async () => {
      if (!(await this.gitService.branchExists(branchName))) {
        try {
          await this.gitService.createBranch(branchName, baseCommit);
        } catch (err) {
          if (!(err as Error).message.includes('already exists')) {
            throw err;
          }
        }
      }
      return branchName;
    })();
    this.branchInitPromises.set(runId, init);
    return init;
  }

  async integrateTaskCommit(options: IntegrateTaskOptions): Promise<string> {
    const { runId, taskId, commitHash, baseCommit } = options;

    // Chain execution sequentially to prevent concurrent Git operations on integration branch
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = this.queueLock;
    this.queueLock = currentLock;

    await previousLock;

    try {
      const branchName = await this.initIntegrationBranch(runId, baseCommit);
      const wt = await this.worktreeManager.createWorktree(
        `integration-${runId}`,
        'main-worker',
        branchName,
      );

      const currentHead = await this.gitService.getHeadCommit(wt.path);
      if (commitHash === currentHead || commitHash === baseCommit) {
        return currentHead;
      }

      // Cherry pick the commit into the integration branch worktree
      const newHead = await this.gitService.cherryPick(commitHash, wt.path);
      await this.gitService.execGit(['update-ref', `refs/heads/${branchName}`, newHead]);
      return newHead;
    } catch (err) {
      const branchName = this.getBranchName(runId);
      const wt = this.worktreeManager.getWorktree(`integration-${runId}`, 'main-worker');
      if (wt) {
        await this.gitService.abortCherryPick(wt.path).catch(() => {});
      }
      throw new IntegrationError(
        `Failed to integrate task ${taskId} (commit ${commitHash}) into ${branchName}: ${(err as Error).message}`,
        { runId, taskId, commitHash, branchName, error: err },
      );
    } finally {
      releaseLock();
    }
  }

  async finalizeRun(
    runId: string,
    config: TaskForgeConfig,
    baseCommit: string,
  ): Promise<{ branchName: string; verified: boolean }> {
    const branchName = await this.initIntegrationBranch(runId, baseCommit);
    const wt = await this.worktreeManager.createWorktree(
      `integration-${runId}`,
      'main-worker',
      branchName,
      {
        detached: true,
      },
    );

    try {
      let verified = true;
      if (this.verificationRunner && config.verification.tests) {
        // A run that only changed documentation has no code to verify; many
        // projects (no package.json) have nothing to discover, which would
        // otherwise fail the whole run after every task already passed.
        const changedFiles = (
          await this.gitService
            .exec(['diff', '--name-only', baseCommit, branchName], this.repoRoot)
            .catch(() => '')
        )
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const documentationOnly = isDocumentationOnlyChange(changedFiles);
        const configuredCommands =
          config.verification.commands && config.verification.commands.length > 0
            ? config.verification.commands
            : documentationOnly
              ? undefined
              : resolveScopedCommandsForFiles(
                  changedFiles,
                  config.verification.scopedCommands ?? [],
                );
        const verResult = await this.verificationRunner.verify({
          taskId: `FINAL-${runId}`,
          runId,
          worktreePath: wt.path,
          config,
          documentationOnlyChange: documentationOnly,
          // What the project says verifies it. Without this only Node scripts are discovered,
          // and a project that configured its own command failed after every task had passed.
          // When `commands` is empty and every non-doc changed file is covered by `scopedCommands`,
          // run the union of those scoped commands instead of an unrelated full-monorepo suite.
          ...(configuredCommands && configuredCommands.length > 0
            ? { explicitCommands: configuredCommands }
            : {}),
        });
        verified = verResult.passed;
        if (!verified) {
          throw new IntegrationError(
            `Final integration verification failed for branch ${branchName}: ${verResult.failureReason}`,
            { runId, branchName, failureReason: verResult.failureReason },
          );
        }
      }

      if (this.eventRepo) {
        this.eventRepo.append({
          id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          runId,
          type: 'INTEGRATION_COMPLETED',
          payload: {
            branchName,
            baseCommit,
            verified,
          },
          timestamp: new Date(),
        });
      }

      return {
        branchName,
        verified,
      };
    } finally {
      await this.worktreeManager
        .removeWorktree(`integration-${runId}`, 'main-worker', true, true)
        .catch(() => {});
    }
  }
}

function normalizeScopePattern(scope: string): string {
  const normalized = scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized === '**' ? '*' : normalized;
}

function scopedRuleMatchesFile(ruleScope: string, filePath: string): boolean {
  const rule = normalizeScopePattern(ruleScope);
  const file = normalizeScopePattern(filePath);
  if (rule === '*') return true;
  if (rule === file) return true;
  if (rule.endsWith('/**')) {
    const prefix = rule.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return false;
}

function scopeSpecificity(scope: string): number {
  return normalizeScopePattern(scope).replace(/[*?]/g, '').length;
}

/**
 * Resolves the deduplicated union of `scopedCommands` when every non-doc
 * changed file matches at least one configured scope rule. Returns `undefined`
 * if any non-doc file is uncovered so `VerificationRunner` falls back safely
 * to full project verification.
 */
function resolveScopedCommandsForFiles(
  changedFiles: string[],
  scopedRules: Array<{ scope: string; commands: string[] }>,
): string[] | undefined {
  if (changedFiles.length === 0 || scopedRules.length === 0) return undefined;
  const nonDocFiles = changedFiles.filter((file) => !isDocumentationOnlyChange([file]));
  if (nonDocFiles.length === 0) return undefined;

  const commands = new Set<string>();
  for (const file of nonDocFiles) {
    const matches = scopedRules
      .filter((rule) => scopedRuleMatchesFile(rule.scope, file))
      .sort((a, b) => scopeSpecificity(b.scope) - scopeSpecificity(a.scope));
    if (matches.length === 0) return undefined;
    const mostSpecific = scopeSpecificity(matches[0].scope);
    for (const rule of matches.filter((m) => scopeSpecificity(m.scope) === mostSpecific)) {
      for (const cmd of rule.commands) {
        if (cmd.trim()) commands.add(cmd);
      }
    }
  }
  return commands.size > 0 ? [...commands] : undefined;
}
