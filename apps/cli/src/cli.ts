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
  AuditService,
} from '@taskforge/persistence';
import { GitService, WorktreeManager, RepositoryAnalyzer } from '@taskforge/workspace';
import { AgentRegistry, AgentDetector, FakeAgent } from '@taskforge/agents';
import { TaskGraph, Task } from '@taskforge/core';
import { VerificationRunner } from '@taskforge/verification';
import { IntegrationService, GitHubWorkflowService } from '@taskforge/integration';
import { DeterministicScheduler, RunOrchestrator } from '@taskforge/scheduler';
import { InteractiveShell, TuiDashboard } from '@taskforge/conversation';
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
    });

  // tf doctor
  program
    .command('doctor')
    .description('Run environment, provider and workspace diagnostic checks')
    .action(async () => {
      console.log('TaskForge Doctor Diagnosing Environment...\n');

      // 1. Node check
      const nodeVer = process.version;
      console.log(`Node.js Runtime: ${nodeVer} (>= 22.0.0 required) - OK`);

      // 2. Git check
      const repoRoot = process.cwd();
      const gitService = new GitService(repoRoot);
      const isGit = await gitService.isGitRepo();
      if (!isGit) {
        console.log('Git Repository: NOT A GIT REPOSITORY (Run inside a git project)');
      } else {
        const status = await gitService.getStatus();
        console.log(
          `Git Repository: OK (Branch: ${status.currentBranch}, HEAD: ${status.headCommit.slice(0, 7)}, Clean: ${status.isClean})`,
        );
      }

      // 3. SQLite check
      try {
        const db = new TaskForgeDatabase(':memory:');
        db.close();
        console.log('SQLite Persistence: OK');
      } catch (err) {
        console.log(`SQLite Persistence: FAILED (${(err as Error).message})`);
      }

      // 4. Repository Analyzer
      try {
        const analyzer = new RepositoryAnalyzer(repoRoot, gitService);
        const profile = await analyzer.analyze();
        console.log(`Repository Profile: ${profile.summary}`);
        if (profile.testCommands.length > 0) {
          console.log(`Test command: ${profile.testCommands[0]}`);
        }
      } catch {
        // ignore
      }

      // 5. Agent Detection
      const registry = new AgentRegistry();
      const reports = await AgentDetector.detect(registry.list());
      console.log('\nAgent Harness Detection:');
      for (const rep of reports) {
        console.log(`  ${rep.name.padEnd(16)} [${rep.id.padEnd(8)}]: ${rep.ready ? '● ready' : '○ not detected'}`);
      }
      console.log('\nDiagnostic complete.');
    });

  // tf inspect <run-id>
  program
    .command('inspect <run-id>')
    .description('Inspect run audit record, tasks, events and integration state')
    .action((runId: string) => {
      const config = loadConfig();
      const db = new TaskForgeDatabase(config.execution.databasePath);
      const runRepo = new RunRepository(db);
      const goalRepo = new GoalRepository(db);
      const taskRepo = new TaskRepository(db);
      const eventRepo = new EventRepository(db);
      const auditService = new AuditService(runRepo, goalRepo, taskRepo, eventRepo);

      const audit = auditService.reconstructRun(runId);
      if (!audit) {
        console.error(`Run ${runId} not found.`);
        process.exit(1);
      }

      console.log(`\n=== TaskForge Run ${audit.run.id} ===`);
      console.log(`Status: ${audit.run.status}`);
      console.log(`Created: ${audit.run.createdAt}`);
      if (audit.goal) {
        console.log(`Goal: ${audit.goal.description}`);
      }

      console.log('\nTasks:');
      for (const t of audit.tasks) {
        console.log(`  - [${t.status.toUpperCase()}] ${t.id}: ${t.title} (${t.type})`);
        if (t.dependencies && t.dependencies.length > 0) {
          console.log(`      Dependencies: ${t.dependencies.join(', ')}`);
        }
      }

      console.log(`\nEvents (${audit.events.length}):`);
      for (const e of audit.events) {
        console.log(`  [${e.timestamp.toISOString()}] ${e.type}${e.taskId ? ` (${e.taskId})` : ''}`);
      }
      console.log('');
      db.close();
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
    .description('Execute a goal in headless deterministic mode')
    .option('-c, --concurrency <number>', 'Maximum parallel tasks', '3')
    .option('--fake', 'Use FakeAgents for deterministic execution', false)
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

      const agentRegistry = new AgentRegistry();
      if (options?.fake) {
        config.verification.tests = false;
        config.verification.lint = false;
        config.verification.typecheck = false;
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

      const taskId = `TASK-${Date.now().toString().slice(-4)}`;
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
    });

  // tf run [goal]
  program
    .command('run [goal]')
    .description('Run full multi-agent orchestration pipeline: plan, negotiate, schedule, verify and integrate')
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
    .description('Display rich visual TUI dashboard of repository state, agents, worktrees, and tasks')
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

  return program;
}


