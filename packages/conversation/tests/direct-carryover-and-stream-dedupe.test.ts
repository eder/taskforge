import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  type AgentAdapter,
  type AgentAssignment,
  type AgentCapabilities,
  type AgentContext,
  type AgentResult,
} from '@taskforge/agents';
import { TaskForgeDatabase } from '@taskforge/persistence';
import {
  DirectAgentRunner,
  DirectConversationMemory,
  InteractiveShell,
} from '../src/index.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-carryover-dedupe-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@taskforge.local"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "TaskForge Test"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
  execSync('git add -A && git commit -m "chore: init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

class StreamingPreambleAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript'],
      tools: ['read'],
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    const finalReport =
      '## Prioridade alta\n1. Corrigir workers remotos em packages/agents/src/remote-adapters.ts\n2. Completar scopedCommands em .taskforge/config.yaml';
    // Simulate Codex CLI emitting a short progress preamble before streaming the full final report
    context.onStreamEvent?.({
      type: 'agent_message',
      text: 'Vou aprofundar a análise no código...',
      runId: 'direct',
      agentId: this.id,
      role: assignment.role,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      timestamp: new Date(),
    });
    context.onStreamEvent?.({
      type: 'agent_message',
      text: finalReport,
      runId: 'direct',
      agentId: this.id,
      role: assignment.role,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      timestamp: new Date(),
    });
    return {
      success: true,
      message: finalReport,
      output: finalReport,
      durationMs: 25,
    };
  }
}

describe('Direct Mode streaming deduplication & Direct-to-Planner context carry-over', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('does not reprint the entire response when stream output had a preamble followed by the final answer', async () => {
    const repoRoot = initTempGitRepo();
    tempDirs.push(repoRoot);
    const registry = new AgentRegistry(false);
    registry.register(new StreamingPreambleAdapter());

    const liveLines: string[] = [];
    const runner = new DirectAgentRunner({
      repoRoot,
      agentRegistry: registry,
      memory: new DirectConversationMemory(),
      onLiveLine: (line) => liveLines.push(line),
    });

    const res = await runner.runAgents(['codex'], 'analisa o projeto');
    const streamedJoined = liveLines.join('');
    expect(streamedJoined).toContain('Corrigir workers remotos');

    // Final formatted summary should show the header badge only — NOT duplicate the full report
    const cleanFormatted = stripAnsi(res.formatted);
    expect(cleanFormatted).toContain('Codex CLI');
    expect(cleanFormatted).not.toContain('Corrigir workers remotos');
  });

  it('attaches the latest Direct Mode report as prior context when the user follows up into Orchestrated Planning', async () => {
    const repoRoot = initTempGitRepo();
    tempDirs.push(repoRoot);
    const db = new TaskForgeDatabase(':memory:');
    const shell = new InteractiveShell({
      repoRoot,
      database: db,
      interactive: false,
      smartDirectDispatch: false,
    });

    // Register fake codex and run a Direct Mode analysis first
    const registry = (shell as unknown as { agentRegistry: AgentRegistry }).agentRegistry;
    registry.register(new StreamingPreambleAdapter());
    await shell.handleInput('@codex analisa o projeto e lista melhorias');

    // Follow up with a natural PT request that escalates to Orchestrated Planning
    const proposal = stripAnsi(
      await shell.handleInput('Então siga fazendo tudo que é necessário'),
    );
    expect(proposal).toContain('Plan Proposal');
    expect(proposal).toContain('using the latest Direct Mode report from Codex CLI');

    const activeGoal = (shell as unknown as { activeGoal?: { context?: string } }).activeGoal;
    expect(activeGoal?.context).toContain('REFERENCE DATA');
    expect(activeGoal?.context).toContain('Corrigir workers remotos');

    // /clear clears direct memory so a subsequent request does NOT carry over old analysis
    await shell.handleInput('/clear');
    const freshProposal = stripAnsi(
      await shell.handleInput('Então siga fazendo tudo que é necessário'),
    );
    expect(freshProposal).not.toContain('using the latest Direct Mode report');
    db.close();
  });
});
