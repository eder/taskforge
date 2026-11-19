import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDefaultConfig, type RepositoryProfile } from '@taskforge/shared';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { TaskGraph, type Goal } from '@taskforge/core';
import { FakeAgent, AgentRegistry } from '@taskforge/agents';
import { RunOrchestrator } from '@taskforge/scheduler';
import { SemanticPlanner } from '@taskforge/planner';
import { OpenAIRoutingProvider, StaticRoutingProvider } from '@taskforge/router';
import { buildHeadlessPlannerAndRouter } from '../src/cli.js';

describe('headless planner and router wiring', () => {
  it('wires SemanticPlanner and OpenAIRoutingProvider when not in --fake mode', () => {
    const config = getDefaultConfig();
    config.router.provider = 'openai';
    config.router.apiKey = 'sk-test-headless';
    const wired = buildHeadlessPlannerAndRouter(process.cwd(), config, { fake: false });
    expect(wired.planner).toBeInstanceOf(SemanticPlanner);
    expect(wired.router).toBeInstanceOf(OpenAIRoutingProvider);
    expect(wired.agentRegistry).toBeInstanceOf(AgentRegistry);
  });

  it('falls back to StaticRoutingProvider without an API key while keeping SemanticPlanner (for agentPlanning)', () => {
    const config = getDefaultConfig();
    config.router.provider = 'openai';
    config.router.apiKey = undefined;
    const prevTf = process.env.TASKFORGE_OPENAI_API_KEY;
    const prevOai = process.env.OPENAI_API_KEY;
    delete process.env.TASKFORGE_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const wired = buildHeadlessPlannerAndRouter(process.cwd(), config, { fake: false });
      expect(wired.planner).toBeInstanceOf(SemanticPlanner);
      expect(wired.router).toBeInstanceOf(StaticRoutingProvider);
    } finally {
      if (prevTf !== undefined) process.env.TASKFORGE_OPENAI_API_KEY = prevTf;
      if (prevOai !== undefined) process.env.OPENAI_API_KEY = prevOai;
    }
  });

  it('returns empty overrides in --fake mode so offline runs stay deterministic', () => {
    const config = getDefaultConfig();
    config.router.apiKey = 'sk-test-headless';
    expect(buildHeadlessPlannerAndRouter(process.cwd(), config, { fake: true })).toEqual({});
  });
});

describe('RunOrchestrator passes RepositoryProfile with repositoryMap to planner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-headless-profile-'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'storage'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'http'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'storage', 'store.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'http', 'router.js'), 'export const y = 2;\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyzes the repository and forwards repositoryMap into planner.plan()', async () => {
    let seenProfile: RepositoryProfile | undefined;
    const spyPlanner = {
      plan: async (goal: Goal, profile?: RepositoryProfile) => {
        seenProfile = profile;
        return new TaskGraph([
          {
            id: 'TASK-01',
            runId: 'pending',
            goalId: goal.id,
            title: 'Inspect',
            description: 'Inspect repo',
            type: 'analysis',
            status: 'ready',
            dependencies: [],
            contract: {
              objective: 'Inspect repo',
              allowedScope: ['*'],
              forbiddenChanges: ['*'],
              acceptanceCriteria: ['Report returned'],
              dependencies: [],
              completionMode: 'report',
            },
            acceptanceCriteria: ['Report returned'],
            reworkCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
      },
    };

    const config = getDefaultConfig();
    config.verification.preflight = false;
    const registry = new AgentRegistry(false);
    registry.register(
      new FakeAgent('fake-1', 'Fake', [{ output: 'Summary of repository modules.' }]),
    );
    const db = new TaskForgeDatabase(':memory:');
    const orchestrator = new RunOrchestrator({
      repoRoot: tmpDir,
      config,
      database: db,
      agentRegistry: registry,
      planner: spyPlanner,
    });

    const result = await orchestrator.run('explain the repository layout');
    db.close();

    expect(result.status).toBe('completed');
    expect(seenProfile).toBeDefined();
    const mapText = (seenProfile?.repositoryMap ?? []).join('\n');
    expect(mapText).toContain('src/storage');
    expect(mapText).toContain('src/http');
  });
});
