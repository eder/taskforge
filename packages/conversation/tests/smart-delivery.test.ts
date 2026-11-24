import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentAssignment, AgentCapabilities, AgentContext, AgentRegistry, AgentResult } from '@taskforge/agents';
import { RunRepository, TaskForgeDatabase } from '@taskforge/persistence';
import type { DeliveryService } from '@taskforge/integration';
import {
  extractRequestedDeliveryIntent,
  buildOrchestratedDeliveryProposal,
  parseDeliveryFollowUpReply,
  formatDirectPostEditHint,
  parseDirectGitIntent,
  InteractiveShell,
} from '../src/index.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-smart-delivery-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@taskforge.local"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "TaskForge Test"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const value = 1;\n', 'utf8');
  execSync('git add -A && git commit -m "chore: init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

class FileEditingFakeAdapter implements AgentAdapter {
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
      tools: ['edit'],
      stdinMode: 'close_after_spawn',
      permissionProtocol: 'provider_native',
      questionProtocol: 'unsupported',
    };
  }

  async execute(_assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    if (context.mutationAllowed) {
      fs.writeFileSync(path.join(context.worktreePath, 'app.ts'), 'export const value = 42;\n', 'utf8');
    }
    return {
      success: true,
      message: 'Updated app.ts to export value = 42.',
      durationMs: 12,
    };
  }
}

describe('Conversational Smart Delivery', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()!;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  describe('extractRequestedDeliveryIntent', () => {
    it('detects PR, commit, and apply delivery intents embedded in PT & EN prompts', () => {
      expect(extractRequestedDeliveryIntent('corrige o bug em app.ts e já abre uma PR')).toEqual({
        kind: 'pr',
        language: 'pt',
      });
      expect(extractRequestedDeliveryIntent('fix retry timeout and open a pull request')).toEqual({
        kind: 'pr',
        language: 'en',
      });
      expect(extractRequestedDeliveryIntent('refatora app.ts, commita e abre PR')).toEqual({
        kind: 'pr',
        language: 'pt',
      });
      expect(extractRequestedDeliveryIntent('atualiza app.ts e faz commit')).toEqual({
        kind: 'commit',
        language: 'pt',
      });
      expect(extractRequestedDeliveryIntent('update README and commit the changes')).toEqual({
        kind: 'commit',
        language: 'en',
      });
      expect(extractRequestedDeliveryIntent('corrige o lint e aplica na main')).toEqual({
        kind: 'apply',
        language: 'pt',
      });
    });

    it('returns undefined for normal prompts without delivery instructions', () => {
      expect(extractRequestedDeliveryIntent('explain how authentication works')).toBeUndefined();
      expect(extractRequestedDeliveryIntent('corrige o bug de paginação em app.ts')).toBeUndefined();
      expect(extractRequestedDeliveryIntent('/pr run-123')).toBeUndefined();
    });
  });

  describe('buildOrchestratedDeliveryProposal', () => {
    it('recommends diff first whenever a run is not verified (never 1-Enter apply/PR)', () => {
      const proposal = buildOrchestratedDeliveryProposal({
        runId: 'run-1',
        branch: 'taskforge/run-1',
        targetBranch: 'main',
        verified: false,
        gitWorkflow: 'github-flow',
        requestedByUser: 'pr',
        language: 'pt',
      });
      expect(proposal.pending.recommendedAction).toBe('diff');
      expect(stripAnsi(proposal.formatted)).toContain('sem checks automatizados');
      expect(stripAnsi(proposal.formatted)).toContain('Enter: ver diff');
    });

    it('recommends PR for verified runs on github-flow or when user requested PR', () => {
      const githubFlow = buildOrchestratedDeliveryProposal({
        runId: 'run-2',
        branch: 'taskforge/run-2',
        targetBranch: 'main',
        verified: true,
        gitWorkflow: 'github-flow',
        language: 'en',
      });
      expect(githubFlow.pending.recommendedAction).toBe('pr');
      expect(stripAnsi(githubFlow.formatted)).toContain('Enter / yes: open PR');

      const requestedPr = buildOrchestratedDeliveryProposal({
        runId: 'run-3',
        branch: 'taskforge/run-3',
        targetBranch: 'feat/x',
        verified: true,
        gitWorkflow: 'trunk',
        requestedByUser: 'pr',
        language: 'pt',
      });
      expect(requestedPr.pending.recommendedAction).toBe('pr');
      expect(stripAnsi(requestedPr.formatted)).toContain('conforme pedido');
    });

    it('recommends apply for verified runs on trunk or feature branches', () => {
      const trunk = buildOrchestratedDeliveryProposal({
        runId: 'run-4',
        branch: 'taskforge/run-4',
        targetBranch: 'feat/payments',
        verified: true,
        gitWorkflow: 'trunk',
        language: 'pt',
      });
      expect(trunk.pending.recommendedAction).toBe('apply');
      expect(stripAnsi(trunk.formatted)).toContain('aplicar em feat/payments');
    });
  });

  describe('parseDeliveryFollowUpReply & combined direct git intents', () => {
    it('parses natural PT & EN replies and ignores unrelated messages', () => {
      expect(parseDeliveryFollowUpReply('sim')).toBe('accept');
      expect(parseDeliveryFollowUpReply('yes')).toBe('accept');
      expect(parseDeliveryFollowUpReply('abre pr')).toBe('pr');
      expect(parseDeliveryFollowUpReply('commita e abre pr')).toBe('pr');
      expect(parseDeliveryFollowUpReply('pode aplicar')).toBe('apply');
      expect(parseDeliveryFollowUpReply('mostra o diff')).toBe('diff');
      expect(parseDeliveryFollowUpReply('descarta')).toBe('discard');
      expect(parseDeliveryFollowUpReply('agora implementa suporte a redis no cache')).toBeUndefined();
    });

    it('recognizes combined commit + PR phrases in parseDirectGitIntent', () => {
      expect(parseDirectGitIntent('commita e abre um pr')?.kind).toBe('pr');
      expect(parseDirectGitIntent('commit and open a PR')?.kind).toBe('pr');
      expect(parseDirectGitIntent('pode commitar')?.kind).toBe('commit');
      expect(parseDirectGitIntent('pode abrir a pr')?.kind).toBe('pr');
    });

    it('formats concise branch-aware post-edit hints', () => {
      const onMain = stripAnsi(formatDirectPostEditHint(['app.ts'], 'main', 'pt'));
      expect(onMain).toContain('abre um pr');
      const onFeature = stripAnsi(formatDirectPostEditHint(['app.ts'], 'feat/x', 'en'));
      expect(onFeature).toContain('feat/x');
    });
  });

  describe('InteractiveShell Direct Mode & Orchestrated end-to-end integration', () => {
    function createShellWithFakeCodex(repoRoot: string, db: TaskForgeDatabase): InteractiveShell {
      const shell = new InteractiveShell({
        repoRoot,
        database: db,
        interactive: false,
        smartDirectDispatch: true,
      });
      const registry = (shell as unknown as { agentRegistry: AgentRegistry }).agentRegistry;
      registry.register(new FileEditingFakeAdapter());
      return shell;
    }

    it('auto-prepares 1-Enter PR confirmation when user asks to edit and open a PR in one prompt', async () => {
      const repoRoot = initTempGitRepo();
      tempDirs.push(repoRoot);
      const db = new TaskForgeDatabase(':memory:');
      const shell = createShellWithFakeCodex(repoRoot, db);

      const out = stripAnsi(
        await shell.handleInput('@codex atualiza app.ts para 42 e já abre uma PR'),
      );
      expect(out).toContain('Modified files: app.ts');
      expect(out).toContain('Confirmar abertura de Pull Request');
      expect(out).toContain('Enter / sim');

      // Cancelling cleanly clears pending confirmation without touching git history.
      const cancelOut = stripAnsi(await shell.handleInput('não'));
      expect(cancelOut).toContain('cancelada');
      db.close();
    });

    it('shows a contextual post-edit delivery hint when prompt has no explicit commit/PR request and commits on "faz commit"', async () => {
      const repoRoot = initTempGitRepo();
      tempDirs.push(repoRoot);
      const db = new TaskForgeDatabase(':memory:');
      const shell = createShellWithFakeCodex(repoRoot, db);

      const editOut = stripAnsi(await shell.handleInput('@codex atualiza app.ts para 42'));
      expect(editOut).toContain('Modified files: app.ts');
      expect(editOut).toContain('abre um pr');

      const prepCommit = stripAnsi(await shell.handleInput('faz commit'));
      expect(prepCommit).toContain('Confirmar commit direto');

      const committed = stripAnsi(await shell.handleInput(''));
      expect(committed).toContain('Commit criado');

      const log = execSync('git log -1 --pretty=%s', { cwd: repoRoot, encoding: 'utf8' }).trim();
      expect(log.length).toBeGreaterThan(0);
      db.close();
    });

    it('handles conversational delivery replies (diff, discard, and unified "faz commit" fallback) for orchestrated runs', async () => {
      const repoRoot = initTempGitRepo();
      tempDirs.push(repoRoot);
      const db = new TaskForgeDatabase(':memory:');
      const shell = createShellWithFakeCodex(repoRoot, db);

      // Create a real integration branch + completed run ready_to_apply
      execSync('git checkout -b taskforge/run-smart-1', { cwd: repoRoot, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoRoot, 'app.ts'), 'export const value = 99;\n', 'utf8');
      execSync('git add -A && git commit -m "feat: update app value"', { cwd: repoRoot, stdio: 'ignore' });
      execSync('git checkout main', { cwd: repoRoot, stdio: 'ignore' });

      const runRepo = new RunRepository(db);
      runRepo.create('run-smart-1', undefined, {
        goal: 'atualiza app.ts para 99',
        baseBranch: 'main',
      });
      runRepo.updateStatus('run-smart-1', 'completed');
      const baseCommit = execSync('git rev-parse main', { cwd: repoRoot, encoding: 'utf8' }).trim();
      const deliveryService = (shell as unknown as { deliveryService: DeliveryService }).deliveryService;
      deliveryService.markReady('run-smart-1', 'taskforge/run-smart-1', 'main', baseCommit);

      // Activate post-run delivery prompt as if run-smart-1 just finished
      (shell as unknown as { activeRunId?: string; lastGoalDescription?: string }).activeRunId = 'run-smart-1';
      (shell as unknown as { lastGoalDescription?: string }).lastGoalDescription = 'atualiza app.ts para 99';
      const banner = stripAnsi(
        (shell as unknown as {
          buildPostRunDeliveryPrompt: (res: { runId: string; status: string }) => string;
        }).buildPostRunDeliveryPrompt({ runId: 'run-smart-1', status: 'completed' }),
      );
      expect(banner).toContain('Pronto para entrega');
      expect(banner).toContain('Enter / sim: aplicar em main');

      // Asking for "diff" inspects the diff and keeps the delivery prompt alive
      const diffReply = stripAnsi(await shell.handleInput('mostra o diff'));
      expect(diffReply).toContain('app.ts');
      expect(diffReply).toContain('Quando decidir');

      // Answering "descarta" marks the run as discarded without typing /discard
      const discardReply = stripAnsi(await shell.handleInput('descarta'));
      expect(discardReply).toContain('marked as discarded');
      expect(deliveryService.getDelivery('run-smart-1')?.status).toBe('discarded');
      db.close();
    });
  });
});
