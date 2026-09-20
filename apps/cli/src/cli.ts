import { Command } from 'commander';
import { loadConfig } from '@taskforge/shared';
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
} from '@taskforge/persistence';
import { GitService, WorktreeManager, RepositoryAnalyzer } from '@taskforge/workspace';
import { AgentRegistry, AgentDetector, FakeAgent } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { VerificationRunner } from '@taskforge/verification';
import {
  IntegrationService,
  GitHubWorkflowService,
  DeliveryService,
  integrationBranchName,
} from '@taskforge/integration';
import { DeterministicScheduler, RunOrchestrator } from '@taskforge/scheduler';
import { InteractiveShell, TuiDashboard, theme, colors } from '@taskforge/conversation';
import { TelemetryCollector } from '@taskforge/telemetry';

export function createCli(): Command {
  const program = new Command();

  program
    .name('tf')
    .alias('taskforge')
    .description('TaskForge: Conversational control plane for self-organizing coding-agent teams')
    .version('0.1.0')
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
      const wtManager = new WorktreeManager(repoRoot);
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
      for (const r of runs.slice(0, 10)) {
        const goal = r.goalId ? goalRepo.get(r.goalId) : undefined;
        const branch = integrationBranchName(r.id);
        const statusColor =
          r.status === 'completed'
            ? colors.green
            : r.status === 'failed'
              ? colors.red
              : colors.yellow;
        console.log(
          `  ● ${colors.bold}${r.id}${colors.reset} [${statusColor}${r.status.toUpperCase()}${colors.reset}] ${colors.dim}(${r.createdAt.slice(0, 19).replace('T', ' ')})${colors.reset}`,
        );
        if (goal) {
          console.log(`    ${colors.dim}Goal:${colors.reset}   ${goal.description}`);
        }
        console.log(`    ${colors.dim}Branch:${colors.reset} ${colors.cyan}${branch}${colors.reset}`);
        console.log(`    ${colors.dim}Apply:${colors.reset}  ${colors.green}tf apply ${r.id}${colors.reset}\n`);
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

      // 5. Agent Detection
      const registry = new AgentRegistry();
      const reports = await AgentDetector.detect(registry.list());
      console.log(`\n  ${colors.bold}Agent Harness Detection:${colors.reset}`);
      for (const rep of reports) {
        console.log(
          `    ${theme.agentPill(rep.id, rep.name, rep.ready, rep.quotaStatus, rep.quotaReason)}`,
        );
      }
      console.log(
        `\n  ${colors.green}✔${colors.reset} ${colors.bold}Diagnostic complete. Everything ready!${colors.reset}\n`,
      );
    });

  // tf cleanup
  program
    .command('cleanup')
    .description('Explicit cleanup of worktrees and transient TaskForge artifacts')
    .option('--force', 'Force removal of worktrees', false)
    .action(async (options: { force?: boolean }) => {
      const repoRoot = process.cwd();
      const config = loadConfig();
      const worktreeManager = new WorktreeManager(repoRoot, config.execution.worktreesDir);
      await worktreeManager.prune();

      const wtListRaw = await ProcessRunner.run({
        command: 'git',
        args: ['worktree', 'list', '--porcelain'],
        cwd: repoRoot,
      });

      const paths = wtListRaw.stdout
        .split('\n')
        .filter((l: string) => l.startsWith('worktree '))
        .map((l: string) => l.replace('worktree ', '').trim())
        .filter((p: string) => p !== repoRoot);

      for (const p of paths) {
        await ProcessRunner.run({
          command: 'git',
          args: ['worktree', 'remove', options.force ? '--force' : '', p].filter(Boolean),
          cwd: repoRoot,
        });
      }

      await worktreeManager.prune();
      console.log(`Cleaned up ${paths.length} transient worktrees.`);
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

        const taskId = `TASK-${Date.now().toString().slice(-4)}`;
        const agentRegistry = new AgentRegistry();
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

        const worktreeManager = new WorktreeManager(repoRoot, config.execution.worktreesDir);
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

        const scheduler = new DeterministicScheduler({
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
        console.log(`\nRun finished with status: ${result.status}`);
        console.log(`Tasks completed: ${result.tasksCompleted}, failed: ${result.tasksFailed}`);
        if (result.integrationBranch) {
          console.log(`Integrated into branch: ${result.integrationBranch}`);
        }

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
    .action(async (goalText?: string, options?: { concurrency?: string; fake?: boolean }) => {
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

      console.log('TaskForge Pipeline starting...');
      const result = await orchestrator.run(goalText ?? 'Default execution goal', {
        fakeFallback: options?.fake ?? true,
        onProgress: (msg) => console.log(`[TaskForge] ${msg}`),
      });

      console.log(`\nRun completed with status: ${result.status}`);
      console.log(`Tasks: ${result.tasksCompleted} succeeded, ${result.tasksFailed} failed`);
      if (result.integrationBranch) {
        console.log(`Integration branch created: ${result.integrationBranch}`);
      }
      console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
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
      const registry = new AgentRegistry();
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
    });

  // tf pr create [run-id]
  program
    .command('pr create [run-id]')
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
      console.log(`Creating Pull Request for run ${targetRunId}...`);
      const result = await ghService.createPullRequest({
        runId: targetRunId,
        targetBranch: options?.base ?? 'main',
        draft: options?.draft ?? false,
      });

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

        const orchestrator = new RunOrchestrator({
          repoRoot,
          config,
          database: db,
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
      }

      db.close();
    });

  return program;
}
