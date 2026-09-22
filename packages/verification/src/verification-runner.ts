import * as fs from 'node:fs';
import * as path from 'node:path';
import { VerificationCheck, VerificationResult, TaskForgeConfig } from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import { EventRepository, VerificationRepository } from '@taskforge/persistence';

export interface RunVerificationOptions {
  taskId: string;
  runId: string;
  worktreePath: string;
  config: TaskForgeConfig;
  taskType?: string;
  customCommands?: {
    testCommand?: string;
    lintCommand?: string;
    typecheckCommand?: string;
    buildCommand?: string;
  };
}

export class VerificationRunner {
  constructor(
    private verificationRepo?: VerificationRepository,
    private eventRepo?: EventRepository,
  ) {}

  async verify(options: RunVerificationOptions): Promise<VerificationResult> {
    const { taskId, runId, worktreePath, config, customCommands, taskType } = options;

    if (this.eventRepo) {
      this.eventRepo.append({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        runId,
        taskId,
        type: 'VERIFY_STARTED',
        payload: { worktreePath },
        timestamp: new Date(),
      });
    }

    // Resolve available scripts in worktree
    let pkgScripts: Record<string, string> | undefined;
    let pm = 'npm';
    const pkgJsonPath = path.join(worktreePath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        pkgScripts = pkg.scripts || {};
        if (fs.existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) pm = 'pnpm';
        else if (fs.existsSync(path.join(worktreePath, 'yarn.lock'))) pm = 'yarn';
        else if (fs.existsSync(path.join(worktreePath, 'bun.lockb'))) pm = 'bun';
      } catch {
        // ignore
      }
    }

    const resolveScript = (
      name: string,
      custom?: string,
      defaultCmd?: string,
    ): { command: string; available: boolean } => {
      if (custom) return { command: custom, available: true };
      if (pkgScripts) {
        if (pkgScripts[name]) {
          return { command: name === 'test' ? `${pm} test` : `${pm} run ${name}`, available: true };
        }
        return { command: defaultCmd ?? `${pm} ${name}`, available: false };
      }
      return { command: defaultCmd ?? `${pm} ${name}`, available: false };
    };

    // Read-only/reporting task types do not need to rerun the repository's
    // full code-quality suite. In particular, a REVIEW task usually follows an
    // implementation that was already verified; rerunning test+lint+typecheck
    // here adds substantial wall time without validating a new mutation.
    const requiresCodeVerification =
      taskType !== 'investigation' &&
      taskType !== 'review';

    const testResolved = resolveScript('test', customCommands?.testCommand, 'pnpm test');
    const lintResolved = resolveScript('lint', customCommands?.lintCommand, 'pnpm lint');
    const typecheckResolved = resolveScript(
      'typecheck',
      customCommands?.typecheckCommand,
      'pnpm typecheck',
    );
    const buildResolved = resolveScript('build', customCommands?.buildCommand, 'pnpm build');

    const checksToRun: Array<{ name: string; command: string; enabled: boolean }> = [
      {
        name: 'test',
        command: testResolved.command,
        enabled: requiresCodeVerification && config.verification.tests && testResolved.available,
      },
      {
        name: 'lint',
        command: lintResolved.command,
        enabled: requiresCodeVerification && config.verification.lint && lintResolved.available,
      },
      {
        name: 'typecheck',
        command: typecheckResolved.command,
        enabled: requiresCodeVerification && config.verification.typecheck && typecheckResolved.available,
      },
      {
        name: 'build',
        command: buildResolved.command,
        enabled: false, // optional by default
      },
    ];

    const results: VerificationCheck[] = [];
    let overallPassed = true;
    let failureReason: string | undefined;

    for (const check of checksToRun) {
      if (!check.enabled) continue;

      const [cmd, ...args] = check.command.split(' ');
      const runResult = await ProcessRunner.run({
        command: cmd,
        args,
        cwd: worktreePath,
        timeoutMs: 60000,
      });

      const checkRecord: VerificationCheck = {
        name: check.name,
        command: check.command,
        exitCode: runResult.exitCode,
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        durationMs: runResult.durationMs,
        success: runResult.exitCode === 0,
      };

      results.push(checkRecord);

      if (runResult.exitCode !== 0) {
        overallPassed = false;
        failureReason = `Check '${check.name}' failed with exit code ${runResult.exitCode}`;
        break; // stop on first verification failure
      }
    }

    const finalResult: VerificationResult = {
      passed: overallPassed,
      checks: results,
      failureReason,
    };

    if (this.verificationRepo) {
      this.verificationRepo.save(taskId, runId, finalResult);
    }

    if (this.eventRepo) {
      this.eventRepo.append({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        runId,
        taskId,
        type: 'VERIFY_COMPLETED',
        payload: {
          passed: overallPassed,
          checksCount: results.length,
          failureReason,
        },
        timestamp: new Date(),
      });
    }

    return finalResult;
  }
}
