import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeAgent } from '../src/fake-agent.js';
import { AgentRegistry, AgentDetector } from '../src/agent-registry.js';
import { GitService } from '@taskforge/workspace';

describe('Agents - FakeAgent and Registry', () => {
  const testDir = path.resolve(__dirname, '../../test-tmp-agent');

  beforeEach(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    const git = new GitService(testDir);
    // initialize git in test dir
    await git['exec'](['init', '-b', 'main'], testDir);
    await git['exec'](['config', 'user.name', 'Test Agent'], testDir);
    await git['exec'](['config', 'user.email', 'agent@test.local'], testDir);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('FakeAgent writes files and creates a git commit', async () => {
    const agent = new FakeAgent('fake-writer', 'Fake Writer');
    agent.addAction({
      writeFile: {
        path: 'src/solution.ts',
        content: 'export const answer = 42;\n',
      },
      gitCommitMessage: 'feat(TASK-1): write solution',
    });

    const result = await agent.execute(
      {
        id: 'ASGN-1',
        taskId: 'TASK-1',
        agentId: 'fake-writer',
        role: 'implementer',
        objective: 'Write solution',
        status: 'running',
      },
      {
        worktreePath: testDir,
        task: {
          objective: 'Write solution',
          allowedScope: ['src/**'],
          forbiddenChanges: [],
          acceptanceCriteria: ['answer is 42'],
          dependencies: [],
        },
        assignment: {
          id: 'ASGN-1',
          taskId: 'TASK-1',
          agentId: 'fake-writer',
          role: 'implementer',
          objective: 'Write solution',
          status: 'running',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(fs.existsSync(path.join(testDir, 'src/solution.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(testDir, 'src/solution.ts'), 'utf8')).toBe(
      'export const answer = 42;\n',
    );
  });

  it('FakeAgent handles failure cleanly', async () => {
    const agent = new FakeAgent('fake-failer', 'Fake Failer', [
      {
        shouldFail: true,
        failMessage: 'Simulated bug',
      },
    ]);

    const result = await agent.execute(
      {
        id: 'ASGN-2',
        taskId: 'TASK-2',
        agentId: 'fake-failer',
        role: 'implementer',
        objective: 'Fail task',
        status: 'running',
      },
      {
        worktreePath: testDir,
        task: {
          objective: 'Fail task',
          allowedScope: [],
          forbiddenChanges: [],
          acceptanceCriteria: [],
          dependencies: [],
        },
        assignment: {
          id: 'ASGN-2',
          taskId: 'TASK-2',
          agentId: 'fake-failer',
          role: 'implementer',
          objective: 'Fail task',
          status: 'running',
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Simulated bug');
  });

  it('AgentRegistry and AgentDetector detect registered harnesses', async () => {
    const registry = new AgentRegistry();
    const fake = new FakeAgent('custom-fake', 'Custom Fake');
    registry.register(fake);

    expect(registry.get('custom-fake')).toBe(fake);
    expect(registry.get('claude')).toBeDefined();

    const reports = await AgentDetector.detect(registry.list());
    expect(reports.length).toBeGreaterThanOrEqual(4);
    const fakeReport = reports.find((r) => r.id === 'custom-fake');
    expect(fakeReport?.ready).toBe(true);
  });

  it('FakeAgent writes to context.logPath when provided', async () => {
    const agent = new FakeAgent('fake-logger', 'Fake Logger', [
      {
        activitySteps: ['Compiling sources...', 'Running tests...'],
      },
    ]);
    const logFile = path.join(testDir, 'fake-run.log');

    await agent.execute(
      {
        id: 'ASGN-LOG',
        taskId: 'TASK-LOG',
        agentId: 'fake-logger',
        role: 'implementer',
        objective: 'Test logging',
        status: 'running',
      },
      {
        worktreePath: testDir,
        logPath: logFile,
        task: {
          objective: 'Test logging',
          allowedScope: [],
          forbiddenChanges: [],
          acceptanceCriteria: [],
          dependencies: [],
        },
        assignment: {
          id: 'ASGN-LOG',
          taskId: 'TASK-LOG',
          agentId: 'fake-logger',
          role: 'implementer',
          objective: 'Test logging',
          status: 'running',
        },
      },
    );

    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('[FakeAgent] Starting assignment');
    expect(content).toContain('[FakeAgent] Compiling sources...');
    expect(content).toContain('[FakeAgent] Running tests...');
  });

  it('CLI adapters parse real-time stream activity and clean output', async () => {
    const { ClaudeCodeAdapter, AntigravityAdapter, CodexAdapter } = await import(
      '../src/real-adapters.js'
    );

    const claude = new ClaudeCodeAdapter();
    const agy = new AntigravityAdapter();
    const codex = new CodexAdapter();

    // Check streaming flags
    expect((claude as any).options.defaultArgs).toContain('--output-format=stream-json');
    expect((agy as any).options.defaultArgs).toContain('stream-json');
    expect((codex as any).options.defaultArgs).toContain('--json');

    // Test extractActivity
    const activities: string[] = [];
    const callback = (act: string) => activities.push(act);

    // 1. Claude tool_use Bash
    (claude as any).extractActivity(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      }),
      callback,
    );
    expect(activities[activities.length - 1]).toBe('Bash: pnpm test');

    // 2. Claude tool_use Edit
    (claude as any).extractActivity(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: 'packages/core/src/graph.ts' } },
          ],
        },
      }),
      callback,
    );
    expect(activities[activities.length - 1]).toBe('Edit graph.ts');

    // 3. AGY step_update
    (agy as any).extractActivity(
      JSON.stringify({
        event: 'step_update',
        step_update: { description: 'Analyzing workspace' },
      }),
      callback,
    );
    expect(activities[activities.length - 1]).toBe('Analyzing workspace');

    // 4. Codex item
    (codex as any).extractActivity(
      JSON.stringify({
        type: 'item',
        item: { command: 'git diff' },
      }),
      callback,
    );
    expect(activities[activities.length - 1]).toBe('git diff');

    // 5. Raw text fallback
    (claude as any).extractActivity('Running linter...\nAll passed\n', callback);
    expect(activities[activities.length - 1]).toBe('All passed');

    // Test extractOutput
    const streamOutput = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Partial text' }] },
      }),
      JSON.stringify({ type: 'result', result: 'Clean final markdown answer' }),
    ].join('\n');

    const cleanResult = (claude as any).extractOutput(streamOutput, '');
    expect(cleanResult).toBe('Clean final markdown answer');
  });

  it('preserves defaultArgs when constructed with empty or undefined options', async () => {
    const { ClaudeCodeAdapter, AntigravityAdapter, CodexAdapter } = await import(
      '../src/real-adapters.js'
    );

    const claude = new ClaudeCodeAdapter({ defaultArgs: undefined } as any);
    const agy = new AntigravityAdapter({ defaultArgs: undefined } as any);
    const codex = new CodexAdapter({ defaultArgs: undefined } as any);

    expect((claude as any).options.defaultArgs).toContain('--output-format=stream-json');
    expect((agy as any).options.defaultArgs).toContain('stream-json');
    expect((codex as any).options.defaultArgs).toContain('--json');

    // Also verify via AgentRegistry with empty agentConfigs
    const registry = new AgentRegistry(true, {
      claude: { enabled: true, maxParallel: 1 },
      codex: { enabled: true, maxParallel: 2 },
      agy: { enabled: true, maxParallel: 1 },
    });

    const regClaude = registry.get('claude');
    const regCodex = registry.get('codex');
    const regAgy = registry.get('agy');

    expect((regClaude as any).options.defaultArgs).toContain('--output-format=stream-json');
    expect((regCodex as any).options.defaultArgs).toEqual(['exec', '--json']);
    expect((regAgy as any).options.defaultArgs).toEqual(['--output-format', 'stream-json', '-p']);
  });

  it('normalizes auto-denied headless tool requests as denied actions', async () => {
    const { AntigravityAdapter } = await import('../src/real-adapters.js');
    const agy = new AntigravityAdapter();

    const rawStderr =
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';

    const outcome = agy.normalizeOutcome('', rawStderr, 0);

    expect(outcome.deniedActions.length).toBe(1);
    expect(outcome.deniedActions[0].action).toBe('command');
    expect(outcome.providerStatus).toBe('FAILED');
    expect(outcome.errors.length).toBeGreaterThan(0);
  });

  it('surfaces the real quota-exhaustion reason instead of a bare "exited with code N"', async () => {
    const { AntigravityAdapter } = await import('../src/real-adapters.js');
    const agy = new AntigravityAdapter();

    // Real stderr tail observed from a live Antigravity run hitting its account quota.
    const rawStderr = [
      'E0921 02:07:54.752093     394 errorreport.go:224] agent executor error: generating and executing: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 59h30m58s.',
      'E0921 02:07:54.767485       1 session.go:256] Print mode: run ended with error and no response: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 59h30m58s.',
      'I0921 02:07:54.771381     386 server.go:1242] Stream goroutine exited for b736b229, sending completion signal',
      'E0921 02:07:54.809855    3031 telemetry.go:82] error recording trajectory segment analytics: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:recordTrajectoryAnalytics": context canceled',
    ].join('\n');

    const outcome = agy.normalizeOutcome('', rawStderr, 3);
    const { message, completionReason } = agy.classifyExecutionFailure(outcome, 3, '', rawStderr, false);

    expect(completionReason).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(message).toContain('rate-limited/quota exceeded');
    expect(message).toContain('Individual quota reached');
    expect(message).toContain('Resets in 59h30m58s');
    // Regression guard: must not regress to the uninformative generic fallback that
    // looked identical to every other unrelated crash and was previously shown to users.
    expect(message).not.toBe(`${agy.name} exited with code 3`);
  });
});

