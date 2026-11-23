import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  TaskForgeDatabase,
  GoalRepository,
  RunRepository,
  TaskRepository,
  EventRepository,
} from '@taskforge/persistence';
import type { AgentAdapter } from '@taskforge/agents';
import type { AgentAssignment, AgentCapabilities, AgentContext, AgentResult } from '@taskforge/shared';
import { assessProblemAndSelectAgent } from '../src/problem-size-router.js';
import { FocusedRunAdvisor } from '../src/focused-run-advisor.js';
import { parseDirectRouteCommand } from '../src/direct-agent-router.js';
import { InteractiveShell } from '../src/interactive-shell.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (s: string) => s.replace(ANSI, '');

class StubAgent implements AgentAdapter {
  public calls: AgentContext[] = [];
  constructor(
    public readonly id: string,
    public readonly name: string,
  ) {}
  async detect(): Promise<boolean> {
    return true;
  }
  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript', 'Python'],
      tools: ['bash', 'file_editor'],
    };
  }
  async execute(_assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.calls.push(context);
    return { success: true, output: `${this.name} handled it`, durationMs: 10 };
  }
}

describe('assessProblemAndSelectAgent (problem-size based agent selection)', () => {
  it('picks fast localized fixer (codex -> claude -> agy) for small test/script failures', () => {
    const rec = assessProblemAndSelectAgent({
      text: "ERROR test_barge_in.py - FileNotFoundError: '-q'\nERROR test_e2e.py - FileNotFoundError: '-q'",
      availableAgents: ['claude', 'codex', 'agy'],
    });
    expect(rec.size).toBe('small');
    expect(rec.primaryAgent).toBe('codex');
    expect(rec.recommendMultiAgent).toBe(false);

    // Falls back gracefully when codex is unavailable
    const fallback = assessProblemAndSelectAgent({
      text: "ERROR test_barge_in.py - FileNotFoundError: '-q'",
      availableAgents: ['claude', 'agy'],
    });
    expect(fallback.primaryAgent).toBe('claude');
  });

  it('picks deeper reasoning agent (claude -> agy -> codex) for medium architectural/multi-file problems', () => {
    const rec = assessProblemAndSelectAgent({
      text: 'Refactor authentication flow across server/auth.py, server/session.py, and server/middleware.py',
      availableAgents: ['codex', 'claude', 'agy'],
    });
    expect(rec.size).toBe('large'); // architectural + 3 files -> large
    expect(rec.primaryAgent).toBe('claude');
    expect(rec.recommendMultiAgent).toBe(true);

    const medium = assessProblemAndSelectAgent({
      text: 'Errors in server/a.py, server/b.py, server/c.py',
      availableAgents: ['codex', 'agy'],
    });
    expect(medium.size).toBe('medium');
    expect(medium.primaryAgent).toBe('agy');
  });

  it('always honors an explicitly requested agent when available', () => {
    const rec = assessProblemAndSelectAgent({
      text: 'Small typo in README.md',
      availableAgents: ['claude', 'codex', 'agy'],
      explicitAgentId: 'agy',
    });
    expect(rec.size).toBe('small');
    expect(rec.primaryAgent).toBe('agy');
    expect(rec.reason).toContain('explicitly requested');
  });
});

describe('FocusedRunAdvisor agent-backed fallback', () => {
  it('uses agentCaller when no OpenAI API key is configured', async () => {
    let called = false;
    const advisor = new FocusedRunAdvisor({
      agentCaller: async () => {
        called = true;
        return {
          action: 'fix_with_agent',
          reply: 'Vou acionar um agente para corrigir o teste.',
          command: null,
          paths: null,
          guidance: 'Fix test_barge_in.py so it does not parse -q as a file path',
          proposedAction: 'none',
        };
      },
    });
    expect(advisor.isAvailable()).toBe(true);
    const decision = await advisor.advise({
      userMessage: 'resolve esse erro e continua',
      runId: 'run-1',
      goal: 'Fix tests',
      failures: [{ taskId: 'T1', title: 'Core', kind: 'blocked', reason: "FileNotFoundError: '-q'" }],
      availableRepairs: [],
      verificationCommands: ['pytest -q'],
      worktreeLinks: [],
      availableAgents: ['Codex CLI (codex)', 'Claude Code (claude)'],
    });
    expect(called).toBe(true);
    expect(decision?.action).toBe('fix_with_agent');
  });
});

describe('@smart direct routing & autonomous chained recovery in InteractiveShell', () => {
  let dir: string;
  let db: TaskForgeDatabase;
  let shell: InteractiveShell | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-smart-rec-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(dir, '.env'), 'LLM_API_KEY=secret\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'],
      { cwd: dir },
    );
    db = new TaskForgeDatabase(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    shell?.close();
    shell = undefined;
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('routes @smart by problem size (single codex for small, parallel top-2 for large read-only)', async () => {
    expect(parseDirectRouteCommand('@smart corrige test_e2e.py')).toEqual({
      kind: 'direct_agents',
      targets: 'smart',
      prompt: 'corrige test_e2e.py',
    });

    const claude = new StubAgent('claude', 'Claude Code');
    const codex = new StubAgent('codex', 'Codex CLI');
    const agy = new StubAgent('agy', 'Google Antigravity');
    shell = new InteractiveShell({ repoRoot: dir, database: db });
    const reg = (shell as unknown as { agentRegistry: { register: (a: AgentAdapter) => void } })
      .agentRegistry;
    reg.register(claude);
    reg.register(codex);
    reg.register(agy);

    // Small problem -> auto-selects Codex
    const smallReply = plain(await shell.handleInput('@smart explique o erro em test_e2e.py'));
    expect(smallReply).toContain('Codex CLI');
    expect(codex.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(0);

    // Large architectural read-only problem -> auto-fans out to Claude + Antigravity
    const largeReply = plain(
      await shell.handleInput(
        '@smart analise a arquitetura de server/a.py, server/b.py, server/c.py, server/d.py, server/e.py e server/f.py',
      ),
    );
    expect(largeReply).toContain('Claude Code');
    expect(largeReply).toContain('Google Antigravity');
    expect(claude.calls).toHaveLength(1);
    expect(agy.calls).toHaveLength(1);
  });

  it('auto-chains from deterministic env repair to size-selected agent REPAIR when a residual non-env error remains', async () => {
    const runId = 'run-1795900000000001';
    new GoalRepository(db).create({ id: `g-${runId}`, description: 'Fix memory layer', repository: dir });
    new RunRepository(db).create(runId, `g-${runId}`, {});
    new RunRepository(db).updateStatus(runId, 'failed');
    new TaskRepository(db).create({
      id: 'TASK-1',
      runId,
      goalId: `g-${runId}`,
      title: 'Core Implementation',
      description: 'Core',
      type: 'implementation',
      status: 'blocked',
      dependencies: [],
      contract: { objective: 'Core', allowedScope: ['**'], forbiddenChanges: [], acceptanceCriteria: [], dependencies: [] },
      acceptanceCriteria: [],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    new EventRepository(db).append({
      id: 'evt-env-1',
      runId,
      taskId: 'TASK-1',
      type: 'TASK_RECOVERY_BLOCKED',
      payload: {
        failureClass: 'environment',
        reason: 'missing env',
        evidence: 'RuntimeError: no LLM api_key configured',
        action: 'block',
      },
      timestamp: new Date(),
    });

    shell = new InteractiveShell({ repoRoot: dir, database: db });
    const reg = (shell as unknown as { agentRegistry: { register: (a: AgentAdapter) => void } })
      .agentRegistry;
    reg.register(new StubAgent('claude', 'Claude Code'));
    reg.register(new StubAgent('codex', 'Codex CLI'));

    const resumeCalls: Array<{
      runId: string;
      skipPreflight?: boolean;
      repairTask?: { title: string; description: string; preferredAgent?: string };
    }> = [];

    (
      shell as unknown as {
        buildOrchestrator: () => {
          checkResumable: () => Promise<undefined>;
          resume: (
            id: string,
            opts: {
              skipPreflight?: boolean;
              repairTask?: { title: string; description: string; preferredAgent?: string };
            },
          ) => Promise<unknown>;
        };
      }
    ).buildOrchestrator = () => ({
      checkResumable: async () => undefined,
      resume: async (id, opts) => {
        resumeCalls.push({ runId: id, skipPreflight: opts.skipPreflight, repairTask: opts.repairTask });
        if (resumeCalls.length === 1) {
          // Simulate residual non-environment failure after `.env` was linked!
          new EventRepository(db).append({
            id: 'evt-residual-2',
            runId: id,
            taskId: 'TASK-1',
            type: 'TASK_RECOVERY_BLOCKED',
            payload: {
              failureClass: 'code_or_test',
              reason: "ERROR test_barge_in.py - FileNotFoundError: '-q'",
              evidence: "ERROR test_barge_in.py - FileNotFoundError: [Errno 2] No such file or directory: '-q'",
              action: 'block',
            },
            timestamp: new Date(),
          });
          return {
            runId: id,
            goalId: `g-${id}`,
            status: 'failed',
            tasksCompleted: 0,
            tasksFailed: 1,
            durationMs: 10,
            graph: { getAllTasks: () => [] },
          };
        }
        return {
          runId: id,
          goalId: `g-${id}`,
          status: 'completed',
          tasksCompleted: 1,
          tasksFailed: 0,
          durationMs: 15,
          graph: { getAllTasks: () => [] },
        };
      },
    });

    // Enter stopped run and say "Faça os ajustes necessários para continuar"
    await (
      shell as unknown as { formatRunSummary: (r: Record<string, unknown>) => Promise<string> }
    ).formatRunSummary({
      runId,
      goalId: `g-${runId}`,
      status: 'failed',
      tasksCompleted: 0,
      tasksFailed: 1,
      durationMs: 10,
      graph: { getAllTasks: () => [] },
    });

    const out = plain(await shell.handleInput('Faça os ajustes necessários para continuar'));

    // 1. Linked `.env` deterministically
    expect(fs.readFileSync(path.join(dir, '.taskforge/config.yaml'), 'utf8')).toContain('.env');
    // 2. Automatically chained to a REPAIR pre-task with problem-size selected agent (codex for small localized test error)
    expect(resumeCalls).toHaveLength(2);
    expect(resumeCalls[0].repairTask).toBeUndefined();
    expect(resumeCalls[1].skipPreflight).toBe(true);
    expect(resumeCalls[1].repairTask?.preferredAgent).toBe('codex');
    expect(resumeCalls[1].repairTask?.description).toContain('test_barge_in.py');
    expect(out).toContain('COMPLETED');
  });
});
