import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  VerificationCheck,
  VerificationResult,
  VerificationExpectation,
  TaskForgeConfig,
} from '@taskforge/shared';
import { ProcessRunner, DEFAULT_ENV_POLICY, EnvironmentPolicy } from '@taskforge/execution';
import { EventRepository, VerificationRepository } from '@taskforge/persistence';

/**
 * Project test suites need the developer's normal environment (DATABASE_URL,
 * JAVA_HOME, GOPATH, ...), so verification inherits it. Secret-looking names
 * (*TOKEN*, *SECRET*, *PASSWORD*, *API_KEY*) and TaskForge's own router key
 * are withheld unless listed in `verification.passEnv`.
 */
export function verificationEnvPolicy(passEnv: string[] = []): EnvironmentPolicy {
  return {
    inherit: true,
    // The router key can never be requested, even explicitly.
    allow: passEnv.filter((name) => name !== 'TASKFORGE_OPENAI_API_KEY'),
    denyPatterns: [...(DEFAULT_ENV_POLICY.denyPatterns ?? []), 'TASKFORGE_OPENAI_API_KEY'],
  };
}

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
const DOC_BASENAMES = new Set(['license', 'notice', 'authors', 'contributors', 'changelog', 'readme', 'codeowners']);

/**
 * True when every changed file is documentation (prose files, or a well-known
 * project doc such as LICENSE). Code, config, scripts and data files are never
 * documentation, even under a docs/ folder. An empty list is not a docs change.
 */
export function isDocumentationOnlyChange(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every((file) => {
    const base = path.posix.basename(file.replace(/\\/g, '/')).toLowerCase();
    const ext = path.posix.extname(base);
    return DOC_EXTENSIONS.has(ext) || (ext === '' && DOC_BASENAMES.has(base));
  });
}

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
  /**
   * Exact command-only completion evidence for verification tasks. When set,
   * these commands replace the repository-wide default verification suite.
   */
  explicitCommands?: string[];
  expectation?: VerificationExpectation;
  /**
   * Every file the task changed is documentation. Code verification cannot be
   * discovered for such a change in many projects (no package.json, ...), and
   * a prose edit has no code to verify, so missing evidence is not a failure.
   * Explicit commands, when configured, still run and still must pass.
   */
  documentationOnlyChange?: boolean;
}

export class VerificationRunner {
  constructor(
    private verificationRepo?: VerificationRepository,
    private eventRepo?: EventRepository,
  ) {}

  async verify(options: RunVerificationOptions): Promise<VerificationResult> {
    const {
      taskId,
      runId,
      worktreePath,
      config,
      customCommands,
      taskType,
      explicitCommands,
      expectation = 'pass',
      documentationOnlyChange = false,
    } = options;

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

    const hasExplicitCommandRequest = explicitCommands !== undefined;
    const requestedCommands = (explicitCommands ?? []).map((command) => command.trim()).filter(Boolean);
    const checksToRun: Array<{ name: string; command: string; enabled: boolean }> =
      hasExplicitCommandRequest
        ? requestedCommands.map((command, index) => ({
            name: `explicit-${index + 1}`,
            command,
            enabled: true,
          }))
        : [
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

      // Commands come from trusted configuration or the repository's own
      // scripts and may use shell syntax (quotes, `&&`, `VAR=1 cmd`), so they
      // run through the shell instead of being split on spaces.
      const shell = process.platform === 'win32' ? { cmd: 'cmd', flag: '/c' } : { cmd: 'sh', flag: '-c' };
      const runResult = await ProcessRunner.run({
        command: shell.cmd,
        args: [shell.flag, check.command],
        cwd: worktreePath,
        timeoutMs: (config.verification.commandTimeoutSeconds ?? 600) * 1000,
        envPolicy: verificationEnvPolicy(config.verification.passEnv),
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

      if (runResult.exitCode !== 0 && expectation === 'pass') {
        overallPassed = false;
        // Say what failed, not just that something did: a bare exit code left
        // the user (and the retrying agent) with nothing to act on.
        const tail = `${runResult.stdout}\n${runResult.stderr}`
          .split('\n')
          .map((line) => line.trimEnd())
          .filter(Boolean)
          .slice(-6)
          .join('\n')
          .slice(-600);
        failureReason =
          `Check '${check.name}' failed with exit code ${runResult.exitCode}` +
          (runResult.timedOut ? ' (timed out)' : '') +
          `\nCommand: ${check.command.split('\n')[0].slice(0, 200)}` +
          (tail ? `\nLast output:\n${tail}` : '');
        break; // stop on first required-to-pass verification failure
      }
    }

    // Fail closed only when verification was actually requested. An explicit
    // configuration with tests/lint/typecheck all disabled is an intentional
    // opt-out (used by deterministic/fake execution and valid user configs),
    // not evidence-discovery failure. An explicit command request, including
    // an empty command list, still requires executable evidence.
    const verificationRequested =
      hasExplicitCommandRequest ||
      config.verification.tests ||
      config.verification.lint ||
      config.verification.typecheck;
    if (
      requiresCodeVerification &&
      verificationRequested &&
      results.length === 0 &&
      !documentationOnlyChange
    ) {
      overallPassed = false;
      failureReason =
        'No verification checks were executed for a code-changing task. ' +
        'TaskForge only discovers checks for Node projects (package.json scripts). ' +
        'Tell it how to verify this project by adding `verification.commands` to ' +
        '.taskforge/config.yaml (run `tf init` to generate one), or see "Verification commands" in docs/usage.md.';
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
          expectation,
          failureReason,
        },
        timestamp: new Date(),
      });
    }

    return finalResult;
  }
}
