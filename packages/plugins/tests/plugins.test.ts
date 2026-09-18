import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  PluginManager,
  TaskForgePlugin,
  TaskContext,
  RunContext,
  ECCPlugin,
  ECCDetector,
} from '../src/index.js';
import { Task } from '@taskforge/core';
import { loadConfig } from '@taskforge/shared';

describe('Plugin SDK & ECC Plugin (Phases 15 & 16)', () => {
  it('runs cleanly with zero registered plugins', async () => {
    const manager = new PluginManager();
    expect(manager.listPlugins()).toHaveLength(0);
    expect(manager.getAllCapabilities()).toHaveLength(0);

    const runCtx: RunContext = {
      runId: 'run-test',
      goalId: 'goal-test',
      repoRoot: '/tmp',
      config: loadConfig(),
    };

    // Should complete cleanly without throwing
    await expect(manager.dispatchRunStart(runCtx)).resolves.toBeUndefined();
    await expect(manager.dispatchRunComplete(runCtx)).resolves.toBeUndefined();
    expect(manager.getErrors()).toHaveLength(0);
  });

  it('isolates errors from failing plugins without crashing orchestration', async () => {
    const manager = new PluginManager();

    const buggyPlugin: TaskForgePlugin = {
      name: 'buggy-plugin',
      version: '0.0.1',
      capabilities: () => [],
      onRunStart: async () => {
        throw new Error('Explosion in plugin onRunStart!');
      },
      beforeTask: async () => {
        throw new Error('Explosion in beforeTask!');
      },
    };

    manager.register(buggyPlugin);

    const runCtx: RunContext = {
      runId: 'run-test',
      goalId: 'goal-test',
      repoRoot: '/tmp',
      config: loadConfig(),
    };

    // Does not throw despite plugin failure
    await manager.dispatchRunStart(runCtx);

    const errors = manager.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].pluginName).toBe('buggy-plugin');
    expect(errors[0].hook).toBe('onRunStart');
    expect(errors[0].error.message).toContain('Explosion');

    // Context should remain intact in beforeTask
    const task: Task = {
      id: 'TASK-1',
      goalId: 'goal-1',
      title: 'Test Task',
      description: 'Desc',
      type: 'implementation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Test',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: ['Passes'],
        dependencies: [],
      },
      acceptanceCriteria: ['Passes'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const taskCtx: TaskContext = {
      task,
      worktreePath: '/tmp/worktree',
      environment: {},
    };

    const outputCtx = await manager.dispatchBeforeTask(taskCtx);
    expect(outputCtx.task.id).toBe('TASK-1');
    expect(manager.getErrors()).toHaveLength(2);
  });

  it('ECCDetector discovers .ecc directory in repo or env', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-test-'));
    const eccDir = path.join(tmpDir, '.ecc');
    fs.mkdirSync(eccDir);
    fs.mkdirSync(path.join(eccDir, 'skills'));
    fs.mkdirSync(path.join(eccDir, 'rules'));

    fs.writeFileSync(path.join(eccDir, 'skills', 'security.md'), '# Security');
    fs.writeFileSync(path.join(eccDir, 'rules', 'clean-code.md'), '# Clean Code');

    const result = ECCDetector.detect(tmpDir);
    expect(result.detected).toBe(true);
    expect(result.source).toBe('repo');
    expect(result.availableSkills).toContain('security');
    expect(result.availableRules).toContain('clean-code');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('selectively loads relevant ECC capabilities and ignores unrelated ones', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-repo-'));
    fs.mkdirSync(path.join(tmpDir, '.ecc'));

    const eccPlugin = new ECCPlugin({ repoRoot: tmpDir });
    expect(eccPlugin.isDetected()).toBe(true);

    // Section 21.2 scenario: backend OAuth implementation
    const selected = eccPlugin.selectCapabilitiesForTask(
      'backend OAuth implementation with JWT',
      'implementation',
    );

    // Must load auth/security, backend patterns, TDD, code review
    expect(selected).toContain('auth/security');
    expect(selected).toContain('backend-patterns');
    expect(selected).toContain('tdd');
    expect(selected).toContain('code-review');

    // Must NOT load ML or Kubernetes
    expect(selected).not.toContain('ml');
    expect(selected).not.toContain('kubernetes');

    // Test beforeTask guideline injection
    const task: Task = {
      id: 'TASK-AUTH',
      goalId: 'goal-1',
      title: 'Implement OAuth',
      description: 'Backend OAuth service',
      type: 'implementation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Implement backend OAuth endpoint',
        allowedScope: ['src/auth/**'],
        forbiddenChanges: ['config/secrets.env'],
        acceptanceCriteria: ['JWT tokens signed securely'],
        dependencies: [],
      },
      acceptanceCriteria: ['Valid tokens'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const taskCtx: TaskContext = {
      task,
      worktreePath: tmpDir,
      environment: {},
    };

    const transformed = await eccPlugin.beforeTask(taskCtx);
    expect(transformed.additionalInstructions).toBeDefined();
    const instructions = transformed.additionalInstructions?.join('\n') ?? '';
    expect(instructions).toContain('ECC Active Guidelines');
    expect(instructions).toContain('ECC Security Rule');
    expect(instructions).toContain('ECC Backend Rule');
    expect(instructions).toContain('ECC TDD Rule');

    // Verify quality gate
    const verifyResult = await eccPlugin.verify({
      taskId: task.id,
      worktreePath: tmpDir,
      commands: [],
    });
    expect(verifyResult.passed).toBe(true);
    expect(verifyResult.gateName).toBe('ecc-quality-gate');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
