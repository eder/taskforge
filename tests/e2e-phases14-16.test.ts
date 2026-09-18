import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GitService, WorktreeManager } from '@taskforge/workspace';
import { AgentRegistry, FakeAgent, ClaudeCodeAdapter, CodexAdapter, GeminiCliAdapter } from '@taskforge/agents';
import { RunOrchestrator } from '@taskforge/scheduler';
import { PluginManager, ECCPlugin } from '@taskforge/plugins';
import { getDefaultConfig, TaskForgeConfig } from '@taskforge/shared';
import { TaskForgeDatabase } from '@taskforge/persistence';

describe('Phases 14-16: Real-Agent E2E v0.1 & Plugin System', () => {
  let testRepoRoot: string;
  let gitService: GitService;
  let baseCommit: string;

  beforeEach(async () => {
    testRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-p14-16-'));
    gitService = new GitService(testRepoRoot);
    await gitService.execGit(['init', '-b', 'main'], testRepoRoot);
    await gitService.execGit(['config', 'user.name', 'TaskForge Bot'], testRepoRoot);
    await gitService.execGit(['config', 'user.email', 'bot@taskforge.dev'], testRepoRoot);

    fs.writeFileSync(path.join(testRepoRoot, 'README.md'), '# Test Project\n');
    baseCommit = await gitService.stageAndCommit('Initial commit', testRepoRoot);
  });

  afterEach(async () => {
    const wm = new WorktreeManager(testRepoRoot, '.taskforge/worktrees');
    await wm.prune().catch(() => {});
    if (fs.existsSync(testRepoRoot)) {
      try {
        fs.rmSync(testRepoRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('Phase 14: runs end-to-end orchestrator from goal to integrated branch', async () => {
    const config: TaskForgeConfig = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;

    const db = new TaskForgeDatabase(':memory:');
    const agentRegistry = new AgentRegistry();
    agentRegistry.register(
      new FakeAgent('test-agent', 'Test Worker', [
        {
          writeFile: {
            path: 'src/feature.ts',
            content: 'export const hello = "taskforge";\n',
          },
          gitCommitMessage: 'feat: add feature file',
        },
      ]),
    );

    const orchestrator = new RunOrchestrator({
      repoRoot: testRepoRoot,
      config,
      agentRegistry,
      database: db,
      gitService,
    });

    const result = await orchestrator.run('Implement user profile feature', {
      baseCommit,
      fakeFallback: true,
    });

    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBeGreaterThan(0);
    expect(result.integrationBranch).toBeDefined();
    expect(result.integrationBranch).toContain('taskforge/run-');

    // Verify branch exists on repository
    const exists = await gitService.branchExists(result.integrationBranch!);
    expect(exists).toBe(true);

    db.close();
  });

  it('Phase 14: real agent adapters can be instantiated and configured', async () => {
    const claude = new ClaudeCodeAdapter({
      binaryPath: 'echo',
      defaultArgs: ['claude-simulated'],
    });
    expect(claude.id).toBe('claude');
    expect(claude.commandBinary).toBe('echo');
    const isDetected = await claude.detect();
    expect(isDetected).toBe(true);

    const codex = new CodexAdapter({
      binaryPath: 'echo',
      defaultArgs: ['codex-simulated'],
    });
    expect(codex.id).toBe('codex');
    expect(await codex.detect()).toBe(true);

    const gemini = new GeminiCliAdapter({
      binaryPath: 'echo',
      defaultArgs: ['gemini-simulated'],
    });
    expect(gemini.id).toBe('gemini');
    expect(await gemini.detect()).toBe(true);
  });

  it('Phase 15 & 16: PluginManager and ECCPlugin work together in lifecycle', async () => {
    // Create .ecc directory
    const eccDir = path.join(testRepoRoot, '.ecc');
    fs.mkdirSync(eccDir);
    fs.mkdirSync(path.join(eccDir, 'skills'));
    fs.writeFileSync(path.join(eccDir, 'skills', 'security.md'), '# Security Rules');

    const pluginManager = new PluginManager();
    const eccPlugin = new ECCPlugin({ repoRoot: testRepoRoot });
    pluginManager.register(eccPlugin);

    expect(pluginManager.listPlugins()).toHaveLength(1);
    expect(pluginManager.getAllCapabilities().length).toBeGreaterThan(0);

    const taskCtx = await pluginManager.dispatchBeforeTask({
      task: {
        id: 'TASK-OAUTH',
        goalId: 'goal-1',
        title: 'Backend OAuth Auth',
        description: 'Implement secure login',
        type: 'implementation',
        status: 'ready',
        dependencies: [],
        contract: {
          objective: 'OAuth authentication token validation',
          allowedScope: ['src/auth/**'],
          forbiddenChanges: [],
          acceptanceCriteria: ['Valid JWT'],
          dependencies: [],
        },
        acceptanceCriteria: ['Valid JWT'],
        reworkCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      worktreePath: testRepoRoot,
      environment: {},
    });

    expect(taskCtx.additionalInstructions).toBeDefined();
    expect(taskCtx.additionalInstructions!.some((i) => i.includes('ECC Security Rule'))).toBe(true);

    const verifyResults = await pluginManager.dispatchVerify({
      taskId: 'TASK-OAUTH',
      worktreePath: testRepoRoot,
      commands: [],
    });

    expect(verifyResults).toHaveLength(1);
    expect(verifyResults[0].passed).toBe(true);
    expect(verifyResults[0].gateName).toBe('ecc-quality-gate');
  });
});
