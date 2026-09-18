import {
  VerificationCheck,
  VerificationResult,
  TaskForgeConfig,
} from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import { EventRepository, VerificationRepository } from '@taskforge/persistence';

export interface RunVerificationOptions {
  taskId: string;
  runId: string;
  worktreePath: string;
  config: TaskForgeConfig;
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
    const { taskId, runId, worktreePath, config, customCommands } = options;

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

    const checksToRun: Array<{ name: string; command: string; enabled: boolean }> = [
      {
        name: 'test',
        command: customCommands?.testCommand ?? 'pnpm test',
        enabled: config.verification.tests,
      },
      {
        name: 'lint',
        command: customCommands?.lintCommand ?? 'pnpm lint',
        enabled: config.verification.lint,
      },
      {
        name: 'typecheck',
        command: customCommands?.typecheckCommand ?? 'pnpm typecheck',
        enabled: config.verification.typecheck,
      },
      {
        name: 'build',
        command: customCommands?.buildCommand ?? 'pnpm build',
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
