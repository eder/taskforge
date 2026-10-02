import * as path from 'node:path';
import { Command } from 'commander';
import { loadConfig, getGlobalStateDatabasePath, TASKFORGE_VERSION } from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';
import {
  TaskForgeDatabase,
  RunRepository,
  GoalRepository,
  TaskRepository,
  AssignmentRepository,
  ExecutionRepository,
  EventRepository,
  VerificationRepository,
  WorkspaceRepository,
  InteractionRepository,
  AgentAvailabilityRepository,
} from '@taskforge/persistence';
import {
  GitService,
  WorktreeManager,
  RepositoryAnalyzer,
  parseAgeSpec,
  detectProjectSetup,
  runCheckCommand,
  calibrateScriptTests,
  scriptLoopCommand,
  renderProjectConfig,
  writeProjectConfig,
  hasProjectConfig,
  PROJECT_CONFIG_RELATIVE_PATH,
} from '@taskforge/workspace';
import { AgentRegistry, AgentDetector, FakeAgent, AgentQuotaTracker } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { VerificationRunner, verificationEnvPolicy } from '@taskforge/verification';
import {
  IntegrationService,
  GitHubWorkflowService,
  DeliveryService,
  integrationBranchName,
} from '@taskforge/integration';
import {
  DeterministicScheduler,
  RunOrchestrator,
  describeRunFailures,
  formatRunFailureLines,
  findPriorRunContext,
  renderPriorContext,
} from '@taskforge/scheduler';
import { InteractiveShell, TuiDashboard, theme, colors, summarizeGoal } from '@taskforge/conversation';
import { TelemetryCollector } from '@taskforge/telemetry';

/**
 * Headless commands must survive Ctrl-C gracefully: the first SIGINT/SIGTERM
 * aborts the run (agents are stopped, the run is marked cancelled and can be
 * continued with `tf resume`); a second one exits immediately. Without this,
 * node dies at once and agent processes (which run in their own process
 * groups) keep running, orphaned, while the run stays "running" forever.
 */
export function installGracefulAbort(label: string): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  let received = 0;
  const handler = (name: NodeJS.Signals) => {
    received++;
    if (received > 1) {
      console.error(`\nReceived ${name} again: exiting immediately.`);
      process.exit(130);
    }
    console.error(`\nReceived ${name}: stopping ${label} (press Ctrl-C again to force exit)...`);
    controller.abort();
  };
  const onInt = () => handler('SIGINT');
  const onTerm = () => handler('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
    },
  };
}

/** Prints why a run did not complete (which task failed and the recorded reason). */
export function printRunFailures(db: TaskForgeDatabase, runId: string): void {
  const lines = formatRunFailureLines(
    describeRunFailures(
      { taskRepo: new TaskRepository(db), eventRepo: new EventRepository(db) },
      runId,
    ),
    runId,
  );
  if (lines.length === 0) return;
  console.log('');
  lines.forEach((line, index) =>
    console.log(index === 0 ? `${colors.bold}${line}${colors.reset}` : line.trimStart().startsWith('✖') ? `${colors.red}${line}${colors.reset}` : `${colors.dim}${line}${colors.reset}`),
  );
}

export function createCli(): Command {
  const program = new Command();

  program
    .name('tf')
    .alias('taskforge')
    .description('TaskForge: Conversational control plane for self-organizing coding-agent teams')
    .version(TASKFORGE_VERSION)
    .action(async () => {
      const shell = new InteractiveShell();
      await shell.start();
      process.exit(0);
    });

  // tf clean
  program
    .command('clean')
    .description('Clean up all orphaned TaskForge worktrees and temporary assignment branches')
    .action(async () => {
      const repoRoot = process.cwd();
      const wtManager = new WorktreeManager(repoRoot, loadConfig().execution.worktreesDir);
      const count = await wtManager.cleanOrphanedWorktreesAndBranches();
      console.log(`\n  ${colors.brand}✦ ${colors.bold}TaskForge Workspace Cleanup${colors.reset}`);
      console.log(
        `  ${colors.green}✔${colors.reset} Cleaned up ${count} temporary TaskForge branches and worktrees.\n`,
      );
    });

  // tf runs
  program
    .command('runs')
    .description('List past execution runs and their git integration branches')
    .action(() => {
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);
      const goalRepo = new GoalRepository(db);
      const runs = runRepo.listAll();
      if (runs.length === 0) {
        console.log('\n  No execution runs recorded yet.\n');
        db.close();
        return;
      }
      console.log(`\n  ${colors.brand}✦ ${colors.bold}TaskForge Runs History${colors.reset}`);
      console.log(`  ${colors.darkGray}${'─'.repeat(64)}${colors.reset}`);
      const deliveryService = new DeliveryService(process.cwd(), new GitService(process.cwd()), runRepo);
      for (const r of runs.slice(0, 10)) {
        const goal = r.goalId ? goalRepo.get(r.goalId) : undefined;
        const statusColor =
          r.status === 'completed'
            ? colors.green
            : r.status === 'failed'
              ? colors.red
              : r.status === 'abandoned'
                ? colors.dim
                : colors.yellow;
        console.log(
          `  ● ${colors.bold}${r.id}${colors.reset} [${statusColor}${r.status.toUpperCase()}${colors.reset}] ${colors.dim}(${r.createdAt.slice(0, 19).replace('T', ' ')})${colors.reset}`,
        );
        if (goal) {
          console.log(`    ${colors.dim}Goal:${colors.reset}   ${summarizeGoal(goal.description)}`);
        }
        // Only runs that produced something to deliver have a branch and an
        // apply step; failed or read-only runs do not.
        const delivery = deliveryService.getDelivery(r.id);
        if (delivery) {
          console.log(`    ${colors.dim}Branch:${colors.reset} ${colors.cyan}${delivery.branch}${colors.reset}`);
          if (delivery.status === 'applied') {
            console.log(
              `    ${colors.dim}Delivery:${colors.reset} ${colors.green}✔ applied${colors.reset} to ${delivery.targetBranch}${delivery.appliedCommit ? ` (${delivery.appliedCommit.slice(0, 7)})` : ''}`,
            );
          } else if (delivery.status === 'pr_created') {
            console.log(`    ${colors.dim}Delivery:${colors.reset} ${colors.cyan}PR opened${colors.reset}${delivery.prUrl ? ` ${delivery.prUrl}` : ''}`);
          } else if (delivery.status === 'discarded') {
            console.log(`    ${colors.dim}Delivery:${colors.reset} ${colors.dim}discarded${colors.reset}`);
          } else {
            console.log(`    ${colors.dim}Apply:${colors.reset}  ${colors.green}tf apply ${r.id}${colors.reset}`);
          }
        } else if (r.status === 'abandoned') {
          console.log(`    ${colors.dim}Abandoned: not offered by tf resume.${colors.reset}`);
        } else if (r.status === 'failed' || r.status === 'cancelled' || r.status === 'running') {
          console.log(`    ${colors.dim}Nothing to apply. To continue it: tf resume ${r.id} (or tf abandon ${r.id})${colors.reset}`);
        } else {
          console.log(`    ${colors.dim}Nothing to apply (no changes to deliver).${colors.reset}`);
        }
        console.log('');
      }
      if (runs.length > 10) {
        console.log(`  ${colors.dim}Showing the 10 most recent of ${runs.length} runs.${colors.reset}\n`);
      }
      console.log(`  ${colors.darkGray}${'─'.repeat(64)}${colors.reset}\n`);
      db.close();
    });

  // tf doctor
  program
    .command('doctor')
    .description('Run environment, provider and workspace diagnostic checks')
    .action(async () => {
      console.log(`\n  ${colors.brand}✦ ${colors.bold}TaskForge Environment Doctor${colors.reset}`);
      console.log(`  ${colors.dim}System and harness diagnostic verification${colors.reset}\n`);

      // 1. Node check
      const nodeVer = process.version;
      console.log(
        `  ${colors.bold}Node.js Runtime:${colors.reset}    ${nodeVer} (>= 22.0.0 required) - ${colors.green}✔ OK${colors.reset}`,
      );

      // 2. Git check
      const repoRoot = process.cwd();
      const gitService = new GitService(repoRoot);
      const isGit = await gitService.isGitRepo();
      if (!isGit) {
        console.log(
          `  ${colors.bold}Git Repository:${colors.reset}     ${colors.red}✖ NOT A GIT REPOSITORY${colors.reset} (Run inside a git project)`,
        );
      } else {
        const status = await gitService.getStatus();
        const cleanBadge = status.isClean
          ? `${colors.green}clean${colors.reset}`
          : `${colors.yellow}modified${colors.reset}`;
        console.log(
          `  ${colors.bold}Git Repository:${colors.reset}     ${colors.green}✔ OK${colors.reset} (${colors.yellow}${status.currentBranch}${colors.reset} • ${status.headCommit.slice(0, 7)} • ${cleanBadge})`,
        );
      }

      // 3. SQLite check
      try {
        const db = new TaskForgeDatabase(':memory:');
        db.close();
        console.log(
          `  ${colors.bold}SQLite Database:${colors.reset}    ${colors.green}✔ OK${colors.reset}`,
        );
      } catch (err) {
        console.log(
          `  ${colors.bold}SQLite Database:${colors.reset}    ${colors.red}✖ FAILED (${(err as Error).message})${colors.reset}`,
        );
      }

      // 3b. Optional project config
      console.log(
        hasProjectConfig(repoRoot)
          ? `  ${colors.bold}Project Config:${colors.reset}     ${colors.green}✔ ${PROJECT_CONFIG_RELATIVE_PATH}${colors.reset}`
          : `  ${colors.bold}Project Config:${colors.reset}     ${colors.dim}none (optional; defaults in use). Run \`tf init\` to create one.${colors.reset}`,
      );

      // 4. Repository Analyzer
      try {
        const analyzer = new RepositoryAnalyzer(repoRoot, gitService);
        const profile = await analyzer.analyze();
        console.log(`  ${colors.bold}Workspace Profile:${colors.reset}  ${profile.summary}`);
        if (profile.testCommands.length > 0) {
          console.log(
            `  ${colors.bold}Test Command:${colors.reset}       ${colors.dim}${profile.testCommands[0]}${colors.reset}`,
          );
        }
      } catch {
        // ignore
      }

      // 5. Agent Detection. Hydrate the durable quota/circuit state first so
      // doctor does not report an exhausted provider as ready after a restart.
      const availabilityDb = new TaskForgeDatabase(getGlobalStateDatabasePath());
      AgentQuotaTracker.getInstance().configureStore(
        new AgentAvailabilityRepository(availabilityDb),
      );
      const registry = new AgentRegistry(true, loadConfig().agents);
      const reports = await AgentDetector.detect(registry.list());
      console.log(`\n  ${colors.bold}Agent Harness Detection:${colors.reset}`);
      for (const rep of reports) {
        console.log(
          `    ${theme.agentPill(rep.id, rep.name, rep.ready, rep.quotaStatus, rep.quotaReason)}`,
        );
      }
      availabilityDb.close();
      console.log(
        `\n  ${colors.green}✔${colors.reset} ${colors.bold}Diagnostic complete.${colors.reset}\n`,
      );
    });

  // tf health
  program
    .command('health')
    .description('Inspect system health for Router, agents, and local database')
    .action(async () => {
      const shell = new InteractiveShell();
      const output = await shell.handleInput('/health');
      console.log(`\n${output}\n`);
    });

  // tf cleanup
  program
    .command('cleanup')
    .description('Explicit cleanup of worktrees and transient TaskForge artifacts')
    .option('--force', 'Force removal of worktrees', false)
    .option('--prune', 'Only remove stale TaskForge worktrees and temporary branches by age', false)
    .option('--older-than <age>', 'Age threshold for --prune (e.g. 12h, 7d, 2w)', '7d')
    .option('--dry-run', 'With --prune: list what would be removed without removing it', false)
    .action(
      async (options: {
        force?: boolean;
        prune?: boolean;
        olderThan?: string;
        dryRun?: boolean;
      }) => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      const worktreeManager = new WorktreeManager(repoRoot, config.execution.worktreesDir);

      if (options.prune) {
        let olderThanMs: number;
        try {
          olderThanMs = parseAgeSpec(options.olderThan ?? '7d');
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
        const report = await worktreeManager.pruneStale({
          olderThanMs,
          dryRun: options.dryRun,
        });
        const verb = report.dryRun ? 'Would remove' : 'Removed';
        for (const p of [...report.worktrees, ...report.directories]) console.log(`  ${p}`);
        for (const b of report.branches) console.log(`  branch ${b}`);
        console.log(
          `${verb} ${report.worktrees.length} worktree(s), ${report.directories.length} leftover director${report.directories.length === 1 ? 'y' : 'ies'} and ${report.branches.length} temporary branch(es) older than ${options.olderThan ?? '7d'}.`,
        );
        return;
      }

      await worktreeManager.prune();

      // Only worktrees under the configured TaskForge worktrees dir are touched;
      // linked worktrees you created yourself are left alone.
      const paths = await worktreeManager.listManagedWorktrees();
      for (const p of paths) {
        await ProcessRunner.run({
          command: 'git',
          args: ['worktree', 'remove', options.force ? '--force' : '', p].filter(Boolean),
          cwd: repoRoot,
        });
      }

      await worktreeManager.prune();
      console.log(`Cleaned up ${paths.length} transient worktrees.`);
    },
    );

  // tf init
  program
    .command('init')
    .description('Create an optional .taskforge/config.yaml for this project (shows it before writing)')
    .option('-y, --yes', 'Write without asking for confirmation', false)
    .option('--print', 'Only print the proposed file; write nothing', false)
    .option('--check', 'Run each detected command once and report whether it works', false)
    .option('--check-timeout <seconds>', 'With --check: stop a command after this many seconds', '120')
    .option('--force', 'Overwrite an existing config', false)
    .action(async (options: { yes?: boolean; print?: boolean; check?: boolean; checkTimeout?: string; force?: boolean }) => {
      const repoRoot = process.cwd();

      if (hasProjectConfig(repoRoot) && !options.force) {
        console.log(
          `\n  ${PROJECT_CONFIG_RELATIVE_PATH} already exists. Edit it directly, or run \`tf init --force\` to replace it.\n`,
        );
        return;
      }

      const setup = detectProjectSetup(repoRoot);

      console.log(`\n  ${colors.brand}✦ ${colors.bold}TaskForge project setup${colors.reset}`);
      console.log(
        `  ${colors.dim}${PROJECT_CONFIG_RELATIVE_PATH} is optional: TaskForge works with its defaults. It mainly tells TaskForge how to verify code changes in this project.${colors.reset}\n`,
      );
      if (setup.stacks.length === 0) {
        console.log('  Detected: nothing recognizable (the file will contain commented examples).');
      } else {
        for (const stack of setup.stacks) {
          console.log(`  Detected: ${stack.label}${stack.autoDiscovered ? ' (TaskForge finds these checks itself)' : ''}`);
        }
      }
      console.log('');

      if (options.check) {
        const timeoutSeconds = Math.max(5, parseInt(options.checkTimeout ?? '120', 10) || 120);
        const abort = installGracefulAbort('the check');

        // Script-style suites: run each file on its own and keep only those that pass here.
        for (const stack of setup.stacks.filter((st) => st.scriptTests)) {
          const suite = stack.scriptTests!;
          console.log(`  --check: running ${suite.files.length} test scripts one by one (${stack.label})`);
          console.log(
            `  ${colors.dim}(each stops after ${Math.min(timeoutSeconds, 60)}s; Ctrl-C to stop; only the ones that pass are kept)${colors.reset}`,
          );
          const calibration = await calibrateScriptTests({
            repoRoot,
            dir: suite.dir,
            python: suite.python,
            files: suite.files,
            timeoutSecondsPerFile: Math.min(timeoutSeconds, 60),
            signal: abort.signal,
            onFile: (file, outcome, why) =>
              console.log(
                outcome === 'passed'
                  ? `  ${colors.green}✔${colors.reset} ${file}`
                  : `  ${colors.red}✖${colors.reset} ${file} ${colors.dim}${why ?? ''}${colors.reset}`,
              ),
          });
          if (abort.signal.aborted) {
            console.log(`  ${colors.yellow}■${colors.reset} stopped before finishing. Nothing was written.\n`);
            process.exitCode = 130;
            abort.dispose();
            return;
          }
          suite.files = calibration.passed;
          suite.excluded = calibration.failed;
          stack.note =
            'Calibrated by `tf init --check`: only the test scripts that passed in this environment are listed. ' +
            'They run one by one (python test_x.py), not with pytest.';
          stack.commands =
            calibration.passed.length > 0
              ? [scriptLoopCommand(suite.dir, suite.python, calibration.passed)]
              : [];
          console.log(
            `  ${calibration.passed.length} passed, ${calibration.failed.length} left out (listed in the file as comments).\n`,
          );
        }

        const commands = setup.stacks.filter((st) => !st.scriptTests).flatMap((stack) => stack.commands);
        if (commands.length === 0 && !setup.stacks.some((st) => st.scriptTests)) {
          console.log('  --check: no detected command to run.\n');
        }
        for (const command of commands) {
          console.log(`  --check: running ${command}`);
          console.log(
            `  ${colors.dim}(runs the command once in this project; stops after ${timeoutSeconds}s; Ctrl-C to stop it now)${colors.reset}`,
          );
          let shown = 0;
          const result = await runCheckCommand(command, {
            cwd: repoRoot,
            timeoutSeconds,
            signal: abort.signal,
            onOutput: (chunk) => {
              // Show the first lines live so it is clear something is happening.
              for (const line of chunk.split('\n').filter((l) => l.trim())) {
                if (shown < 12) console.log(`  ${colors.dim}│ ${line.slice(0, 160)}${colors.reset}`);
                else if (shown === 12) console.log(`  ${colors.dim}│ ... (more output hidden; the last lines are shown at the end)${colors.reset}`);
                shown++;
              }
            },
            onHeartbeat: (seconds) =>
              console.log(`  ${colors.dim}… still running (${seconds}s)${colors.reset}`),
          });
          const seconds = (result.durationMs / 1000).toFixed(1);
          if (result.status === 'passed') {
            console.log(`  ${colors.green}✔${colors.reset} works (exit 0, ${seconds}s)\n`);
          } else if (result.status === 'cancelled') {
            console.log(`  ${colors.yellow}■${colors.reset} stopped before finishing. Nothing was written.\n`);
            process.exitCode = 130;
            break;
          } else {
            const why =
              result.status === 'timeout'
                ? `timed out after ${timeoutSeconds}s (it may be waiting for a service, a database or input)`
                : `failed (exit ${result.exitCode}, ${seconds}s)`;
            console.log(`  ${colors.red}✖${colors.reset} ${why}. Fix the command before relying on it:`);
            for (const line of result.tail) console.log(`    ${line.slice(0, 160)}`);
            if (result.tip) console.log(`\n  ${colors.yellow}Tip:${colors.reset} ${result.tip}`);
            console.log('');
            process.exitCode = 2;
          }
        }
        abort.dispose();
      }

      const content = renderProjectConfig(setup);
      console.log(`\n  ${colors.dim}--- proposed ${PROJECT_CONFIG_RELATIVE_PATH} ---${colors.reset}`);
      console.log(content.split('\n').map((l) => `  ${l}`).join('\n'));
      console.log(`  ${colors.dim}--- end ---${colors.reset}\n`);

      if (options.print) return;

      let confirmed = Boolean(options.yes);
      if (!confirmed) {
        if (!process.stdin.isTTY) {
          console.log('  Not writing: no terminal to ask for confirmation. Re-run with --yes to write it.\n');
          process.exitCode = 1;
          return;
        }
        const rl = (await import('node:readline/promises')).createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = (await rl.question(`  Write ${PROJECT_CONFIG_RELATIVE_PATH}? [Y/n] `)).trim().toLowerCase();
        rl.close();
        confirmed = answer === '' || answer === 'y' || answer === 'yes';
      }
      if (!confirmed) {
        console.log('\n  Nothing written. TaskForge will keep using its defaults.\n');
        return;
      }

      const written = writeProjectConfig(repoRoot, content, options.force);
      await new GitService(repoRoot).ensureLocalExclude('.taskforge/');
      console.log(`\n  ${colors.green}✔${colors.reset} Wrote ${path.relative(repoRoot, written)}`);
      console.log('  Review it, then run `tf doctor` to check your setup.\n');
    });

  // tf exec [goal]
  program
    .command('exec [goal]')
    .description('Execute engineering objective in headless automation mode')
    .option('-y, --yes', 'Automatically confirm plan and non-interactive permissions', false)
    .option('-c, --concurrency <number>', 'Maximum parallel tasks', '3')
    .option('--fake', 'Use FakeAgents for deterministic execution', false)
    .action(
      async (
        goalText?: string,
        options?: { yes?: boolean; concurrency?: string; fake?: boolean },
      ) => {
        const repoRoot = process.cwd();
        const config = loadConfig();
        if (options?.concurrency) {
          config.execution.maxParallelTasks = parseInt(options.concurrency, 10);
        }

        const gitService = new GitService(repoRoot);
        const isGit = await gitService.isGitRepo();
        if (!isGit) {
          console.error('Error: Must be run inside a Git repository.');
          process.exit(1);
        }

        const headCommit = await gitService.getHeadCommit();
        const runId = `run-${Date.now()}`;
        console.log(`Starting TaskForge run: ${runId}`);
        console.log(`Base commit: ${headCommit.slice(0, 7)}`);

        const db = new TaskForgeDatabase(config.execution.databasePath);
        const runRepo = new RunRepository(db);
        const goalRepo = new GoalRepository(db);
        const taskRepo = new TaskRepository(db);
        const assignmentRepo = new AssignmentRepository(db);
        const executionRepo = new ExecutionRepository(db);
        const eventRepo = new EventRepository(db);
        const verificationRepo = new VerificationRepository(db);
        const workspaceRepo = new WorkspaceRepository(db);

        const goal = goalRepo.create({
          id: `goal-${Date.now()}`,
          description: goalText ?? 'Deterministic goal execution',
          repository: repoRoot,
        });

        runRepo.create(runId, goal.id);

        // Task ids are global keys in the database: never reuse one from an earlier run.
        const taskId = `TASK-${String(new TaskRepository(db).maxNumericTaskId() + 1).padStart(2, '0')}`;
        const agentRegistry = new AgentRegistry(true, config.agents);
        const preferredAgentMapping: Record<string, string> = {};
        if (options?.fake) {
          config.verification.tests = false;
          config.verification.lint = false;
          config.verification.typecheck = false;
          config.verification.review = false;
          preferredAgentMapping[taskId] = 'fake-agent';
          agentRegistry.register(
            new FakeAgent('fake-agent', 'Fake Agent', [
              {
                writeFile: {
                  path: 'taskforge-output.txt',
                  content: `Executed run ${runId} at ${new Date().toISOString()}\n`,
                },
                gitCommitMessage: `feat: completed task in run ${runId}`,
              },
            ]),
          );
        }

        const worktreeManager = new WorktreeManager(
          repoRoot,
          config.execution.worktreesDir,
          config.execution.worktreeLinks,
        );
        const verificationRunner = new VerificationRunner(verificationRepo, eventRepo);
        const integrationService = new IntegrationService(
          repoRoot,
          gitService,
          worktreeManager,
          verificationRunner,
          eventRepo,
        );

        // Define default task
        const defaultTask: Task = {
          id: taskId,
          goalId: goal.id,
          title: 'Initial Goal Execution',
          description: goal.description,
          type: 'implementation',
          status: 'accepted',
          dependencies: [],
          contract: {
            objective: goal.description,
            allowedScope: ['*'],
            forbiddenChanges: [],
            acceptanceCriteria: ['Task completes'],
            dependencies: [],
          },
          acceptanceCriteria: ['Completed'],
          reworkCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        taskRepo.create({
          id: defaultTask.id,
          runId,
          goalId: goal.id,
          title: defaultTask.title,
          description: defaultTask.description,
          type: defaultTask.type,
          status: defaultTask.status,
          contract: defaultTask.contract,
        });

        const graph = new TaskGraph([defaultTask]);

        const abort = installGracefulAbort('execution');
        const scheduler = new DeterministicScheduler({
          abortSignal: abort.signal,
          runId,
          baseCommit: headCommit,
          repoRoot,
          config,
          graph,
          agentRegistry,
          preferredAgentMapping,
          worktreeManager,
          gitService,
          verificationRunner,
          integrationService,
          runRepo,
          taskRepo,
          assignmentRepo,
          executionRepo,
          eventRepo,
          workspaceRepo,
        });

        const result = await scheduler.run();
        abort.dispose();
        console.log(`\nRun finished with status: ${result.status}`);
        console.log(`Tasks completed: ${result.tasksCompleted}, failed: ${result.tasksFailed}`);
        if (result.integrationBranch) {
          console.log(`Integrated into branch: ${result.integrationBranch}`);
        }
        if (result.status === 'failed') printRunFailures(db, runId);

        db.close();
      },
    );

  // tf run [goal]
  program
    .command('run [goal]')
    .description(
      'Run full multi-agent orchestration pipeline: plan, negotiate, schedule, verify and integrate',
    )
    .option('-c, --concurrency <number>', 'Maximum parallel tasks', '3')
    .option('--fake', 'Force deterministic fake agent fallback', false)
    .option('--context <run>', 'Give the agents the output of an earlier run (a run id, or "last")')
    .action(async (goalText?: string, options?: { concurrency?: string; fake?: boolean; context?: string }) => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      if (options?.concurrency) {
        config.execution.maxParallelTasks = parseInt(options.concurrency, 10);
      }

      const gitService = new GitService(repoRoot);
      const isGit = await gitService.isGitRepo();
      if (!isGit) {
        console.error('Error: Must be run inside a Git repository.');
        process.exit(1);
      }

      const orchestrator = new RunOrchestrator({
        repoRoot,
        config,
        gitService,
      });

      let priorContext: { runId: string; text: string; chars: number } | undefined;
      if (options?.context) {
        const ctxDb = new TaskForgeDatabase(config.execution.databasePath);
        const found = findPriorRunContext(
          { runRepo: new RunRepository(ctxDb), goalRepo: new GoalRepository(ctxDb) },
          {
            explicitRunId: options.context === 'last' ? undefined : options.context,
            maxAgeHours: options.context === 'last' ? config.context?.maxAgeHours : Number.MAX_SAFE_INTEGER,
            maxChars: config.context?.maxChars,
          },
        );
        ctxDb.close();
        if (!found) {
          console.error(
            options.context === 'last'
              ? 'Error: no recent completed run with a report to use as context. See `tf runs`.'
              : `Error: run ${options.context} not found or has no recorded output.`,
          );
          process.exit(1);
        }
        priorContext = { runId: found.runId, text: renderPriorContext(found), chars: found.chars };
      }

      console.log('TaskForge Pipeline starting...');
      const abort = installGracefulAbort('the run');
      let result;
      try {
        result = await orchestrator.run(goalText ?? 'Default execution goal', {
          fakeFallback: options?.fake ?? true,
          priorContext,
          onProgress: (msg) => console.log(`[TaskForge] ${msg}`),
          abortSignal: abort.signal,
        });
      } finally {
        abort.dispose();
      }

      console.log(`\nRun completed with status: ${result.status}`);
      console.log(`Tasks: ${result.tasksCompleted} succeeded, ${result.tasksFailed} failed`);
      if (result.integrationBranch) {
        console.log(`Integration branch created: ${result.integrationBranch}`);
      }
      console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
      if (result.status === 'failed') {
        const reportDb = new TaskForgeDatabase(config.execution.databasePath);
        printRunFailures(reportDb, result.runId);
        reportDb.close();
        process.exitCode = 1;
      }
      if (result.status === 'cancelled') {
        console.log(`Run cancelled. Continue it with: tf resume ${result.runId}`);
        process.exitCode = 130;
      }
    });

  // tf abandon <run-id>
  program
    .command('abandon <run-id>')
    .description('Close a failed, cancelled or interrupted run you no longer want to resume')
    .action((runId: string) => {
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);
      const run = runRepo.get(runId);
      if (!run) {
        console.error(`\nRun ${runId} not found. Use \`tf runs\` to list runs.\n`);
        db.close();
        process.exitCode = 1;
        return;
      }
      if (run.status === 'completed') {
        console.error(`\nRun ${runId} is completed; there is nothing to abandon. Deliver it with tf apply / tf pr create.\n`);
        db.close();
        process.exitCode = 1;
        return;
      }
      runRepo.updateStatus(runId, 'abandoned');
      new EventRepository(db).append({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        runId,
        type: 'RUN_ABANDONED',
        payload: { previousStatus: run.status },
        timestamp: new Date(),
      });
      console.log(`\n  ${colors.green}✔${colors.reset} Run ${runId} abandoned. It will no longer be offered by \`tf resume\`.`);
      console.log(
        `  ${colors.dim}Nothing was deleted: any work kept on taskforge/candidate/* branches is still there.${colors.reset}\n`,
      );
      db.close();
    });

  // tf resume [run-id]
  program
    .command('resume [run-id]')
    .description(
      'Resume an interrupted, cancelled or failed run: keeps integrated tasks and re-executes the rest',
    )
    .option('-c, --concurrency <number>', 'Maximum parallel tasks', '3')
    .option('--fake', 'Force deterministic fake agent fallback', false)
    .option('--fresh', 'Discard work kept from blocked tasks and start those tasks over', false)
    .action(async (runId?: string, options?: { concurrency?: string; fake?: boolean; fresh?: boolean }) => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      if (options?.concurrency) {
        config.execution.maxParallelTasks = parseInt(options.concurrency, 10);
      }

      const gitService = new GitService(repoRoot);
      if (!(await gitService.isGitRepo())) {
        console.error('Error: Must be run inside a Git repository.');
        process.exit(1);
      }

      const db = new TaskForgeDatabase(config.execution.databasePath);
      const orchestrator = new RunOrchestrator({ repoRoot, config, gitService, database: db });

      let targetRunId = runId;
      if (!targetRunId) {
        // Without an id, continue the newest run that can actually be resumed.
        // Older runs (for example from before resume checkpoints existed) are
        // skipped, and listed so the user knows why.
        const candidates = new RunRepository(db)
          .listAll()
          .filter((r) => r.status === 'failed' || r.status === 'cancelled' || r.status === 'running');
        const skipped: Array<{ id: string; reason: string }> = [];
        for (const candidate of candidates) {
          const reason = await orchestrator.checkResumable(candidate.id);
          if (!reason) {
            targetRunId = candidate.id;
            break;
          }
          skipped.push({ id: candidate.id, reason });
        }
        if (!targetRunId) {
          console.error(
            candidates.length === 0
              ? '\nNothing to resume: no failed, cancelled or interrupted runs. Use `tf runs` to see all runs.\n'
              : `\nNothing to resume: ${candidates.length} failed/cancelled run(s) were found but none can be continued:`,
          );
          for (const { id, reason } of skipped.slice(0, 5)) console.error(`  - ${reason.startsWith(`Run ${id}`) ? reason : `${id}: ${reason}`}`);
          if (skipped.length > 5) console.error(`  ... and ${skipped.length - 5} more`);
          if (skipped.length > 0) console.error('\nStart a new run instead, or use `tf runs` to inspect them.\n');
          db.close();
          process.exit(1);
        }
        if (skipped.length > 0) {
          console.log(`[TaskForge] Skipped ${skipped.length} run(s) that cannot be resumed (run 'tf resume <id>' for the reason); resuming ${targetRunId}.`);
        }
      }

      const abort = installGracefulAbort('the run');
      try {
        const result = await orchestrator.resume(targetRunId, {
          fakeFallback: options?.fake ?? false,
          freshStart: options?.fresh ?? false,
          onProgress: (msg) => console.log(`[TaskForge] ${msg}`),
          abortSignal: abort.signal,
        });
        console.log(`\nRun ${result.runId} finished with status: ${result.status}`);
        console.log(`Tasks: ${result.tasksCompleted} integrated, ${result.tasksFailed} failed`);
        if (result.integrationBranch) {
          console.log(`Integration branch: ${result.integrationBranch}`);
        }
        if (result.status === 'failed') printRunFailures(db, result.runId);
        if (result.status === 'cancelled') {
          console.log(`Run cancelled. Continue it again with: tf resume ${result.runId}`);
          process.exitCode = 130;
        } else if (result.status !== 'completed') {
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(`\n✖ Could not resume ${targetRunId}: ${(err as Error).message}\n`);
        process.exitCode = 1;
      } finally {
        abort.dispose();
        db.close();
      }
    });

  // tf status / tf dash
  program
    .command('status')
    .alias('dash')
    .description(
      'Display rich visual TUI dashboard of repository state, agents, worktrees, and tasks',
    )
    .action(async () => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      const gitService = new GitService(repoRoot);
      const gitStatus = await gitService.getStatus().catch(() => ({
        currentBranch: 'unknown',
        headCommit: 'unknown',
        isClean: true,
      }));
      const registry = new AgentRegistry(true, loadConfig().agents);
      const availabilityDb = new TaskForgeDatabase(getGlobalStateDatabasePath());
      AgentQuotaTracker.getInstance().configureStore(
        new AgentAvailabilityRepository(availabilityDb),
      );
      const agents = await AgentDetector.detect(registry.list());

      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);
      const runs = runRepo.listAll();
      const latestRun = runs[0];

      const telemetry = new TelemetryCollector(db);
      const runStats = latestRun ? telemetry.getRunSummary(latestRun.id) : undefined;
      const costReport = latestRun ? telemetry.getCostReport(latestRun.id) : undefined;

      const output = TuiDashboard.render({
        repoRoot,
        branch: gitStatus.currentBranch,
        headCommit: gitStatus.headCommit,
        isClean: gitStatus.isClean,
        agents,
        runStats,
        costReport,
      });

      console.log(output);
      db.close();
      availabilityDb.close();
    });

  // tf pr create [run-id]
  program
    .command('pr')
    .description('Pull request commands')
    .command('create [run-id]')
    .description('Create a pull request on GitHub with verified audit evidence summary')
    .option('-b, --base <branch>', 'Base target branch', 'main')
    .option('-d, --draft', 'Create PR as draft', false)
    .action(async (runId?: string, options?: { base?: string; draft?: boolean }) => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);

      const targetRunId = runId ?? runRepo.listAll()[0]?.id;
      if (!targetRunId) {
        console.error('Error: No run found. Specify a run-id: tf pr create <run-id>');
        db.close();
        process.exit(1);
      }

      const ghService = new GitHubWorkflowService(db, repoRoot);
      const deliveryService = new DeliveryService(repoRoot, new GitService(repoRoot), runRepo);
      console.log(`Creating Pull Request for run ${targetRunId}...`);
      const headBranch = await deliveryService.prepareDeliveryBranch(targetRunId);
      const result = await ghService.createPullRequest({
        runId: targetRunId,
        targetBranch: options?.base ?? 'main',
        draft: options?.draft ?? false,
        headBranch,
      });
      if (result.success && result.prUrl && deliveryService.getDelivery(targetRunId)) {
        deliveryService.markPrCreated(targetRunId, result.prUrl);
      }

      console.log(`\n${result.message}`);
      if (!result.success && !result.prUrl) {
        console.log('\n--- Generated PR Description Markdown ---');
        console.log(result.summary);
      }
      db.close();
    });

  // tf apply [run-id]
  program
    .command('apply [run-id]')
    .description('Apply a completed run\'s changes to its target branch')
    .action(async (runId?: string) => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);
      const gitService = new GitService(repoRoot);
      const deliveryService = new DeliveryService(repoRoot, gitService, runRepo);

      const targetRunId = runId ?? deliveryService.findLatestReady()?.runId;
      if (!targetRunId) {
        console.error('Error: No run is ready to apply. Specify a run-id: tf apply <run-id>');
        db.close();
        process.exit(1);
      }

      try {
        const result = await deliveryService.apply(targetRunId);
        if (result.alreadyApplied) {
          console.log(`\n✔ ${targetRunId} was already applied (commit ${result.commit.slice(0, 7)}).\n`);
        } else {
          console.log(`\n✔ Applied ${targetRunId} successfully (commit ${result.commit.slice(0, 7)}).\n`);
        }
      } catch (err) {
        console.error(`\n✖ Could not apply ${targetRunId}: ${(err as Error).message}\n`);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // tf issue <number>
  program
    .command('issue <number>')
    .description('Import a GitHub issue and orchestrate a team to solve it')
    .option('--fake', 'Force deterministic fake agent fallback', false)
    .action(async (issueNum: string, options?: { fake?: boolean }) => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const ghService = new GitHubWorkflowService(db, repoRoot);

      console.log(`Importing GitHub Issue #${issueNum}...`);
      try {
        const issue = await ghService.importIssue(issueNum);
        console.log(`Imported Issue: "${issue.title}"`);

        const availabilityDb = new TaskForgeDatabase(getGlobalStateDatabasePath());
        const orchestrator = new RunOrchestrator({
          repoRoot,
          config,
          database: db,
          availabilityDatabase: availabilityDb,
        });

        const result = await orchestrator.run(issue.goalText, {
          fakeFallback: options?.fake ?? true,
          onProgress: (msg) => console.log(`[TaskForge] ${msg}`),
        });

        console.log(`\nIssue run finished with status: ${result.status}`);
        if (result.integrationBranch) {
          console.log(`Integrated changes into branch: ${result.integrationBranch}`);
        }
      } catch (err) {
        console.error(`Error importing issue: ${(err as Error).message}`);
      } finally {
        db.close();
      }
    });

  // tf cost [run-id]
  program
    .command('cost [run-id]')
    .description('View cost breakdown and token telemetry for a run')
    .action((runId?: string) => {
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);
      const targetRunId = runId ?? runRepo.listAll()[0]?.id;

      if (!targetRunId) {
        console.log('No runs recorded yet.');
      } else {
        const telemetry = new TelemetryCollector(db);
        console.log(telemetry.formatCostReport(targetRunId));
      }
      db.close();
    });

  // tf inspect <run-id>
  program
    .command('inspect [run-id]')
    .description('Inspect detailed structured run state, tasks, assignments and interactions')
    .option('--json', 'Output full run report as JSON', false)
    .action((runId?: string, options?: { json?: boolean }) => {
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);
      const targetRunId = runId ?? runRepo.listAll()[0]?.id;

      if (!targetRunId) {
        console.log(options?.json ? '{}' : 'No runs recorded yet.');
        db.close();
        return;
      }

      const run = runRepo.get(targetRunId);
      const goalRepo = new GoalRepository(db);
      const taskRepo = new TaskRepository(db);
      const assignmentRepo = new AssignmentRepository(db);
      const verificationRepo = new VerificationRepository(db);
      const interactionRepo = new InteractionRepository(db);
      const telemetry = new TelemetryCollector(db);

      const goal = run?.goalId ? goalRepo.get(run.goalId) : undefined;
      const tasks = taskRepo.listByRun(targetRunId);
      const assignments = tasks.flatMap((t) => assignmentRepo.listByTask(t.id));
      const interactions = interactionRepo.listAllRequests(targetRunId);
      const metrics = telemetry.getRunSummary(targetRunId);
      const cost = telemetry.getCostReport(targetRunId);

      if (options?.json) {
        console.log(
          JSON.stringify(
            {
              run,
              goal,
              tasks,
              assignments,
              interactions,
              metrics,
              cost,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`\n========================================`);
        console.log(` RUN INSPECTION: ${targetRunId}`);
        console.log(`========================================`);
        console.log(`Status:       ${run?.status.toUpperCase()}`);
        console.log(`Created:      ${run?.createdAt}`);
        console.log(`Completed:    ${run?.completedAt ?? 'in progress / active'}`);
        if (goal) {
          console.log(`Goal:         ${goal.description}`);
        }
        console.log(`\nTasks (${tasks.length}):`);
        for (const t of tasks) {
          const ver = verificationRepo.getLatestByTask(t.id);
          console.log(
            `  ● ${t.id}: ${t.title} [${t.status.toUpperCase()}] (verified: ${ver ? (ver.passed ? 'YES' : 'NO') : 'N/A'})`,
          );
        }
        printRunFailures(db, targetRunId);
        if (interactions.length > 0) {
          console.log(`\nInteractions (${interactions.length}):`);
          for (const i of interactions) {
            console.log(`  ● [${i.id}] ${i.type}: ${i.prompt} [${i.status.toUpperCase()}]`);
          }
        }
        if (cost) {
          console.log(
            `\nCost: $${cost.totalCostUsd.toFixed(4)} (${cost.totalInputTokens + cost.totalOutputTokens} tokens)`,
          );
        }
        if (metrics?.staffingBottlenecks) {
          const {
            staffingCappedCount,
            collaborationRejectedCount,
            collaborationDelayedCount,
            collaborationApprovedCount,
          } = metrics.staffingBottlenecks;
          if (
            staffingCappedCount > 0 ||
            collaborationRejectedCount > 0 ||
            collaborationDelayedCount > 0 ||
            collaborationApprovedCount > 0
          ) {
            console.log(`\nCollaboration & Staffing:`);
            if (staffingCappedCount > 0) {
              console.log(`  ⚠ Staffing capped: ${staffingCappedCount} time(s) (hit maxAgentsPerTask limit)`);
            }
            if (collaborationRejectedCount > 0) {
              console.log(`  ⚠ Collaboration rejected: ${collaborationRejectedCount} proposal(s) (hit maxAgentsPerTask limit)`);
            }
            if (collaborationDelayedCount > 0) {
              console.log(`  ⏳ Collaboration delayed: ${collaborationDelayedCount} proposal(s) (waiting for concurrency slot)`);
            }
            if (collaborationApprovedCount > 0) {
              console.log(`  ✓ Collaboration approved: ${collaborationApprovedCount} proposal(s)`);
            }
          }
        }
      }

      db.close();
    });

  return program;
}
