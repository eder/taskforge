import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { getDefaultConfig } from '@taskforge/shared';
import { RepositoryAnalyzer } from '@taskforge/workspace';
import {
  buildDeterministicLivingPlan,
  refineLivingPlan,
  saveLivingPlan,
  loadLivingPlan,
  deleteLivingPlan,
  getLivingPlanPath,
  shouldOfferLivingPlan,
  buildWaveExecutionGoal,
  markWaveStatus,
  getNextPendingWave,
  InteractiveShell,
} from '../src/index.js';

function createGreenfieldRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wave-c-greenfield-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@taskforge.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TaskForge Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# New Project\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.taskforge/\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Wave C: Domain-Agnostic Living Plan (.taskforge/plan.md) & Wave Execution', () => {
  it('detects greenfield repositories accurately in RepositoryAnalyzer', async () => {
    const repoRoot = createGreenfieldRepo();
    tempDirs.push(repoRoot);

    const analyzer = new RepositoryAnalyzer(repoRoot);
    const emptyProfile = await analyzer.analyze();
    expect(emptyProfile.isGreenfield).toBe(true);
    expect(emptyProfile.sourceFileCount).toBe(0);

    // Add real source files + package.json -> no longer greenfield
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' } }),
      'utf8',
    );
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add source'], { cwd: repoRoot, stdio: 'ignore' });

    const populatedProfile = await analyzer.analyze();
    expect(populatedProfile.isGreenfield).toBe(false);
    expect(populatedProfile.sourceFileCount).toBeGreaterThanOrEqual(2);
  });

  it('generates domain-agnostic blueprints (e.g. CLI/data pipeline without backend/frontend assumptions) and persists losslessly to .taskforge/plan.md', async () => {
    const repoRoot = createGreenfieldRepo();
    tempDirs.push(repoRoot);

    const plan = buildDeterministicLivingPlan(
      'Build a Rust CLI log analyzer from scratch with ingestion, tokenizer, and query engine',
      {
        languages: [],
        frameworks: [],
        testCommands: [],
        lintCommands: [],
        typecheckCommands: [],
        buildCommands: [],
        hasECC: false,
        summary: 'empty',
        isGreenfield: true,
        sourceFileCount: 0,
      },
    );

    expect(plan.isGreenfield).toBe(true);
    expect(plan.stack).toContain('Rust');
    expect(plan.modules.map((m) => m.id)).toEqual(['ingestion', 'tokenizer', 'query-engine']);
    // Must never hardcode backend/frontend!
    expect(plan.modules.some((m) => /frontend|backend/i.test(m.id))).toBe(false);
    expect(plan.waves).toHaveLength(3);
    expect(plan.waves[0].mode).toBe('sequential');
    expect(plan.waves[1].mode).toBe('parallel');
    expect(plan.waves[1].modules).toEqual(['ingestion', 'tokenizer', 'query-engine']);
    expect(plan.waves[2].mode).toBe('sequential');

    // Persist and reload losslessly
    const savedPath = saveLivingPlan(repoRoot, plan);
    expect(savedPath).toBe(getLivingPlanPath(repoRoot));
    const md = fs.readFileSync(savedPath, 'utf8');
    expect(md).toContain('## Modules (Disjoint Ownership Boundaries)');
    expect(md).toContain('### [ ] Wave 1 — Foundation & Shared Contracts');
    expect(md).toContain('### [ ] Wave 2 — Parallel Module Implementation');

    const reloaded = loadLivingPlan(repoRoot);
    expect(reloaded).toBeDefined();
    expect(reloaded?.modules).toHaveLength(3);
    expect(reloaded?.waves[1].modules).toEqual(['ingestion', 'tokenizer', 'query-engine']);

    // Refine conversationally: add module + remove module + add stack
    const refined = await refineLivingPlan(
      reloaded!,
      'usa SQLite, adiciona módulo de alertas e remove tokenizer',
    );
    expect(refined.stack).toContain('SQLite');
    expect(refined.modules.some((m) => m.id === 'alertas')).toBe(true);
    expect(refined.modules.some((m) => m.id === 'tokenizer')).toBe(false);
    expect(refined.waves[1].modules).toContain('alertas');
    expect(refined.waves[1].modules).not.toContain('tokenizer');

    expect(deleteLivingPlan(repoRoot)).toBe(true);
    expect(loadLivingPlan(repoRoot)).toBeUndefined();
  });

  it('re-scans actual Wave 1 files into Wave 2 parallel fan-out goal prompt', async () => {
    const repoRoot = createGreenfieldRepo();
    tempDirs.push(repoRoot);

    let plan = buildDeterministicLivingPlan(
      'Criar sistema de agendamento de barbearia com agenda, clientes e notificacoes em TypeScript',
    );
    plan = markWaveStatus(plan, 1, 'completed', {
      runId: 'run-wave-1',
      summary: 'Created src/contracts and package.json',
    });

    // Simulate files actually created by Wave 1
    fs.mkdirSync(path.join(repoRoot, 'src', 'contracts'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'contracts', 'types.ts'), 'export interface Slot { id: string; }\n');
    fs.mkdirSync(path.join(repoRoot, 'src', 'agenda'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'agenda', 'index.ts'), 'export {};\n');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'wave 1 foundation'], { cwd: repoRoot, stdio: 'ignore' });

    const liveProfile = await new RepositoryAnalyzer(repoRoot).analyze();
    const wave2 = getNextPendingWave(plan)!;
    expect(wave2.number).toBe(2);

    const wave2Goal = buildWaveExecutionGoal(plan, wave2, liveProfile);
    expect(wave2Goal).toContain('[Living Plan — Wave 2/3: Parallel Module Implementation]');
    expect(wave2Goal).toContain('Parallel fan-out requirement');
    expect(wave2Goal).toContain('allowedScope: [src/agenda/**, tests/agenda/**]');
    expect(wave2Goal).toContain('Completed earlier waves');
    expect(wave2Goal).toContain('Live repository layout observed right now');
    expect(wave2Goal).toContain('src/contracts');
  });

  it('runs end-to-end greenfield Living Plan alignment, refinement, Wave 1 execution, and automatic .taskforge/plan.md progression in InteractiveShell', async () => {
    const repoRoot = createGreenfieldRepo();
    tempDirs.push(repoRoot);

    const db = new TaskForgeDatabase(':memory:');
    const out = new PassThrough();
    const config = getDefaultConfig();
    config.verification.preflight = false;
    config.verification.commands = [];
    config.planner.agentPlanning = 'never';

    const shell = new InteractiveShell({
      repoRoot,
      config,
      database: db,
      output: out,
      interactive: false,
      smartDirectDispatch: false,
      enableLivingPlanAutoDetect: true,
    });

    // 1. Greenfield detection triggers Living Plan blueprint automatically
    expect(
      shouldOfferLivingPlan('Construir um sistema de agendamento com agenda e clientes', {
        languages: [],
        frameworks: [],
        testCommands: [],
        lintCommands: [],
        typecheckCommands: [],
        buildCommands: [],
        hasECC: false,
        summary: '',
        isGreenfield: true,
      }, { allowAutoGreenfield: true }).shouldOffer,
    ).toBe(true);

    const blueprintOut = await shell.handleInput(
      'Construir um sistema de agendamento para barbearia em TypeScript com agenda, clientes e servicos',
    );
    expect(blueprintOut).toContain('Living Plan');
    expect(blueprintOut).toContain('Wave 1: Foundation & Shared Contracts');
    expect(blueprintOut).toContain('Wave 2: Parallel Module Implementation');
    expect(fs.existsSync(getLivingPlanPath(repoRoot))).toBe(true);

    // 2. Conversational refinement updates .taskforge/plan.md
    const refinedOut = await shell.handleInput('usa SQLite e adiciona módulo de pagamentos');
    expect(refinedOut).toContain('SQLite');
    expect(refinedOut).toContain('Pagamentos');
    expect(loadLivingPlan(repoRoot)?.modules.some((m) => m.id === 'pagamentos')).toBe(true);

    // 3. Press Enter to launch Wave 1 -> proposes orchestrated task graph for Wave 1
    const wave1Proposal = await shell.handleInput('');
    expect(wave1Proposal).toContain('Plan Proposal');
    expect(loadLivingPlan(repoRoot)?.waves[0].status).toBe('in_progress');

    // 4. Approve Wave 1 with simulated FakeAgent -> marks Wave 1 completed and prompts Wave 2!
    const wave1Result = await shell.handleInput('yes --fake');
    expect(wave1Result).toContain('Living Plan Progress');
    expect(wave1Result).toContain('Wave 1/3');
    expect(wave1Result).toContain('Wave 2');
    const afterWave1 = loadLivingPlan(repoRoot)!;
    expect(afterWave1.waves[0].status).toBe('completed');
    expect(afterWave1.waves[0].runId).toBeTruthy();
    expect(getNextPendingWave(afterWave1)?.number).toBe(2);

    // 5. /blueprint reset removes .taskforge/plan.md cleanly
    const resetOut = await shell.handleInput('/blueprint reset');
    expect(resetOut).toContain('Removed .taskforge/plan.md');
    expect(loadLivingPlan(repoRoot)).toBeUndefined();

    db.close();
  });
});
