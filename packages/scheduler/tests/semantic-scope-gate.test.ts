import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDefaultConfig } from '@taskforge/shared';
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { TaskGraph, type Task } from '@taskforge/core';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { RunOrchestrator } from '../src/run-orchestrator.js';

function makeTask(id: string): Task {
  return {
    id,
    goalId: 'g-ast',
    title: 'Extend shared contract safely',
    description: 'Add optional field to SharedConfig without breaking existing callers',
    type: 'implementation',
    status: 'accepted',
    dependencies: [],
    contract: {
      objective: 'Extend SharedConfig safely',
      allowedScope: ['src/**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['SharedConfig extended cleanly'],
      dependencies: [],
      completionMode: 'mutation',
    },
    acceptanceCriteria: ['SharedConfig extended cleanly'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Scheduler semantic AST scope boundary gate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-semantic-gate-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/contract.ts'),
      'export interface SharedConfig {\n  host: string;\n  port: number;\n}\n',
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    execFileSync('git', ['add', '-A'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a breaking exported interface change, triggers rework with AST evidence, and integrates once fixed', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    // Attempt 1 breaks SharedConfig by dropping `port`; Attempt 2 restores `port` and adds optional `tls?`.
    registry.register(
      new FakeAgent('ast-agent', 'AST Agent', [
        {
          writeFile: {
            path: 'src/contract.ts',
            content: 'export interface SharedConfig {\n  host: string;\n}\n',
          },
          gitCommitMessage: 'feat: accidentally drop port',
        },
        {
          writeFile: {
            path: 'src/contract.ts',
            content: 'export interface SharedConfig {\n  host: string;\n  port: number;\n  tls?: boolean;\n}\n',
          },
          gitCommitMessage: 'fix: preserve port and add optional tls',
        },
      ]),
    );

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.verification.preflight = false;
    config.verification.commands = ['node -e "process.exit(0)"'];
    config.verification.maxReworkCycles = 2;
    config.verification.semanticAudit = {
      enabled: true,
      blockOnBreakingExports: true,
      blockOnUnexportedChanges: false,
      scopes: ['src/**'],
    };

    const orchestrator = new RunOrchestrator({
      repoRoot: tmpDir,
      config,
      database: db,
      agentRegistry: registry,
    });

    const result = await orchestrator.run('Extend SharedConfig safely', {
      preplannedGraph: new TaskGraph([makeTask('TASK-AST-1')]),
    });

    const events = new EventRepository(db).listByRun(result.runId);
    const semanticViolations = events.filter((e) => e.type === 'SEMANTIC_SCOPE_VIOLATION');
    expect(semanticViolations).toHaveLength(1);
    expect(JSON.stringify(semanticViolations[0].payload)).toContain('SharedConfig.port');
    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(1);
    db.close();
  }, 60_000);

  it('passes on first try for non-breaking exported changes', async () => {
    const db = new TaskForgeDatabase(':memory:');
    const registry = new AgentRegistry(false);
    registry.register(
      new FakeAgent('ast-agent-ok', 'AST Agent OK', [
        {
          writeFile: {
            path: 'src/contract.ts',
            content: 'export interface SharedConfig {\n  host: string;\n  port: number;\n  retries?: number;\n}\n',
          },
          gitCommitMessage: 'feat: add optional retries field',
        },
      ]),
    );

    const config = getDefaultConfig();
    config.verification.tests = false;
    config.verification.lint = false;
    config.verification.typecheck = false;
    config.verification.review = false;
    config.verification.preflight = false;
    config.verification.commands = ['node -e "process.exit(0)"'];
    config.verification.semanticAudit = {
      enabled: true,
      blockOnBreakingExports: true,
      blockOnUnexportedChanges: false,
      scopes: ['src/**'],
    };

    const orchestrator = new RunOrchestrator({
      repoRoot: tmpDir,
      config,
      database: db,
      agentRegistry: registry,
    });

    const result = await orchestrator.run('Add optional retries to SharedConfig', {
      preplannedGraph: new TaskGraph([makeTask('TASK-AST-2')]),
    });

    const events = new EventRepository(db).listByRun(result.runId);
    expect(events.some((e) => e.type === 'SEMANTIC_SCOPE_VIOLATION')).toBe(false);
    expect(result.status).toBe('completed');
    db.close();
  }, 60_000);
});
