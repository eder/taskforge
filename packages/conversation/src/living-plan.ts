import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_OPENAI_BASE_URL,
  type RepositoryProfile,
} from '@taskforge/shared';
import { TaskGraph, type Task } from '@taskforge/core';
import { colors } from './theme.js';

export type WaveStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface LivingPlanModule {
  id: string;
  name: string;
  responsibility: string;
  /** Disjoint directory/file boundaries for parallel fan-out without conflicts. */
  scope: string[];
  dependsOn: string[];
}

export interface LivingPlanWave {
  number: number;
  name: string;
  mode: 'sequential' | 'parallel';
  status: WaveStatus;
  objective: string;
  /** Module IDs targeted by this wave (typically populated on parallel fan-out waves). */
  modules: string[];
  acceptanceCriteria: string[];
  runId?: string;
  completedAt?: string;
  summary?: string;
}

export interface LivingPlan {
  version: 1;
  title: string;
  goal: string;
  stack: string[];
  architectureNotes: string[];
  contracts: string[];
  modules: LivingPlanModule[];
  waves: LivingPlanWave[];
  isGreenfield: boolean;
  createdAt: string;
  updatedAt: string;
}

export type LivingPlanGeneratorFn = (input: {
  goal: string;
  repoProfile?: RepositoryProfile;
  existingPlan?: LivingPlan;
  feedback?: string;
}) => Promise<LivingPlan | undefined>;

export interface GenerateLivingPlanOptions {
  repoProfile?: RepositoryProfile;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiModel?: string;
  /** Optional custom generator callback (ideal for deterministic tests or agent-backed calls). */
  generator?: LivingPlanGeneratorFn;
}

const PLAN_REL_PATH = path.join('.taskforge', 'plan.md');
const STATE_BLOCK_START = '<!-- taskforge-plan-state';
const STATE_BLOCK_END = 'taskforge-plan-state -->';

export function getLivingPlanPath(repoRoot: string): string {
  return path.join(repoRoot, PLAN_REL_PATH);
}

/**
 * Renders a Living Plan to a clean, human-readable `.taskforge/plan.md` document
 * with an embedded JSON state block for lossless reload across sessions.
 */
export function renderLivingPlanMarkdown(plan: LivingPlan): string {
  const lines: string[] = [
    `# ${plan.title}`,
    '',
    `> **Goal:** ${plan.goal}`,
    `> **Mode:** ${plan.isGreenfield ? 'Greenfield (from scratch)' : 'Multi-phase evolution'} · **Updated:** ${plan.updatedAt}`,
    '',
  ];

  if (plan.stack.length > 0) {
    lines.push('## Stack & Tooling', '');
    for (const item of plan.stack) lines.push(`- ${item}`);
    lines.push('');
  }

  if (plan.contracts.length > 0) {
    lines.push('## Shared Contracts & Boundaries', '');
    for (const c of plan.contracts) lines.push(`- ${c}`);
    lines.push('');
  }

  if (plan.architectureNotes.length > 0) {
    lines.push('## Architecture Notes', '');
    for (const note of plan.architectureNotes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## Modules (Disjoint Ownership Boundaries)', '');
  if (plan.modules.length === 0) {
    lines.push('- *(No modules defined yet)*');
  } else {
    for (const mod of plan.modules) {
      const scopeStr = mod.scope.length > 0 ? ` — scope: \`${mod.scope.join('`, `')}\`` : '';
      const depStr = mod.dependsOn.length > 0 ? ` (depends on: ${mod.dependsOn.join(', ')})` : '';
      lines.push(`- **${mod.name}** (\`${mod.id}\`)${scopeStr}${depStr}: ${mod.responsibility}`);
    }
  }
  lines.push('');

  lines.push('## Execution Waves', '');
  for (const wave of plan.waves) {
    const checkbox =
      wave.status === 'completed'
        ? '[x]'
        : wave.status === 'in_progress'
          ? '[~]'
          : wave.status === 'failed'
            ? '[!]'
            : '[ ]';
    const modeLabel = wave.mode === 'parallel' ? 'parallel fan-out' : 'sequential';
    lines.push(`### ${checkbox} Wave ${wave.number} — ${wave.name} (${modeLabel})`);
    lines.push('');
    lines.push(wave.objective);
    if (wave.modules.length > 0) {
      lines.push(`- **Modules:** ${wave.modules.join(', ')}`);
    }
    if (wave.acceptanceCriteria.length > 0) {
      lines.push('- **Acceptance criteria:**');
      for (const ac of wave.acceptanceCriteria) lines.push(`  - ${ac}`);
    }
    if (wave.runId) {
      lines.push(`- **Run:** \`${wave.runId}\`${wave.completedAt ? ` (${wave.completedAt})` : ''}`);
    }
    if (wave.summary) {
      lines.push(`- **Outcome:** ${wave.summary}`);
    }
    lines.push('');
  }

  lines.push(STATE_BLOCK_START);
  lines.push(JSON.stringify(plan, null, 2));
  lines.push(STATE_BLOCK_END);
  lines.push('');

  return lines.join('\n');
}

export function saveLivingPlan(repoRoot: string, plan: LivingPlan): string {
  const filePath = getLivingPlanPath(repoRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stamped: LivingPlan = { ...plan, updatedAt: new Date().toISOString() };
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, renderLivingPlanMarkdown(stamped), 'utf8');
  fs.renameSync(temp, filePath);
  return filePath;
}

export function loadLivingPlan(repoRoot: string): LivingPlan | undefined {
  const filePath = getLivingPlanPath(repoRoot);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const startIdx = raw.indexOf(STATE_BLOCK_START);
    const endIdx = raw.indexOf(STATE_BLOCK_END);
    if (startIdx >= 0 && endIdx > startIdx) {
      const jsonText = raw.slice(startIdx + STATE_BLOCK_START.length, endIdx).trim();
      const parsed = JSON.parse(jsonText) as Partial<LivingPlan>;
      if (parsed && parsed.version === 1 && typeof parsed.title === 'string' && Array.isArray(parsed.waves)) {
        return {
          version: 1,
          title: parsed.title,
          goal: typeof parsed.goal === 'string' ? parsed.goal : parsed.title,
          stack: Array.isArray(parsed.stack) ? parsed.stack.map(String) : [],
          architectureNotes: Array.isArray(parsed.architectureNotes)
            ? parsed.architectureNotes.map(String)
            : [],
          contracts: Array.isArray(parsed.contracts) ? parsed.contracts.map(String) : [],
          modules: Array.isArray(parsed.modules) ? parsed.modules : [],
          waves: parsed.waves,
          isGreenfield: Boolean(parsed.isGreenfield),
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function deleteLivingPlan(repoRoot: string): boolean {
  const filePath = getLivingPlanPath(repoRoot);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

export function getNextPendingWave(plan: LivingPlan): LivingPlanWave | undefined {
  return plan.waves.find((w) => w.status === 'pending' || w.status === 'failed' || w.status === 'in_progress');
}

export function markWaveStatus(
  plan: LivingPlan,
  waveNumber: number,
  status: WaveStatus,
  meta: { runId?: string; summary?: string } = {},
): LivingPlan {
  const now = new Date().toISOString();
  return {
    ...plan,
    updatedAt: now,
    waves: plan.waves.map((w) =>
      w.number === waveNumber
        ? {
            ...w,
            status,
            ...(meta.runId ? { runId: meta.runId } : {}),
            ...(meta.summary ? { summary: meta.summary } : {}),
            ...(status === 'completed' ? { completedAt: now } : {}),
          }
        : w,
    ),
  };
}

const EXPLICIT_BLUEPRINT_RE =
  /\b(?:blueprint|living\s+plan|plano\s+em\s+(?:ondas|waves|fases)|plan\s+in\s+(?:waves|phases)|do\s+zero|from\s+scratch|arquitetura\s+do\s+zero|constru[ií](?:r)?\s+(?:um|uma)\s+(?:sistema|plataforma|aplica[çc][aã]o|cli|servi[çc]o|ferramenta|biblioteca)\s+(?:complet[oa]|do\s+zero)|build\s+(?:a|an)\s+(?:complete|full|entire|new)\s+(?:system|platform|application|cli|service|tool|library)\s+(?:from\s+scratch)?)\b/i;

const GREENFIELD_BUILD_RE =
  /\b(?:constru[ií](?:r)?|cria(?:r)?|desenvolv(?:er|a)|implement(?:ar|e)|build|create|develop|scaffold)\b/i;

/**
 * Decides whether a goal should enter the interactive Living Plan (`.taskforge/plan.md`)
 * flow before spawning parallel worktrees. Completely domain-agnostic: works for
 * CLIs, libraries, data pipelines, compilers, APIs, mobile apps, or full systems.
 */
export function shouldOfferLivingPlan(
  goalText: string,
  repoProfile?: RepositoryProfile,
  options: { allowAutoGreenfield?: boolean } = {},
): { shouldOffer: boolean; reason: string } {
  const text = goalText.trim();
  if (!text) return { shouldOffer: false, reason: 'empty goal' };

  if (EXPLICIT_BLUEPRINT_RE.test(text)) {
    return {
      shouldOffer: true,
      reason: repoProfile?.isGreenfield
        ? 'greenfield project blueprint requested'
        : 'phased wave blueprint explicitly requested',
    };
  }

  if (options.allowAutoGreenfield && repoProfile?.isGreenfield && GREENFIELD_BUILD_RE.test(text) && text.length >= 24) {
    return {
      shouldOffer: true,
      reason: 'empty/greenfield repository — align contracts & modules before parallel fan-out',
    };
  }

  return { shouldOffer: false, reason: 'standard incremental task' };
}

const KNOWN_STACK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\btypescript|\bts\b/i, label: 'TypeScript' },
  { re: /\bjavascript|\bnode(?:\.?js)?\b/i, label: 'Node.js' },
  { re: /\bpython\b/i, label: 'Python' },
  { re: /\bfastapi\b/i, label: 'FastAPI' },
  { re: /\bdjango\b/i, label: 'Django' },
  { re: /\brust\b/i, label: 'Rust' },
  { re: /\bgo(?:lang)?\b/i, label: 'Go' },
  { re: /\bswift\b/i, label: 'Swift' },
  { re: /\breact\b/i, label: 'React' },
  { re: /\bnext(?:\.?js)?\b/i, label: 'Next.js' },
  { re: /\bvue\b/i, label: 'Vue' },
  { re: /\bsqlite\b/i, label: 'SQLite' },
  { re: /\bpostgres(?:ql)?\b/i, label: 'PostgreSQL' },
  { re: /\bredis\b/i, label: 'Redis' },
  { re: /\bdocker\b/i, label: 'Docker' },
  { re: /\bgraphql\b/i, label: 'GraphQL' },
  { re: /\bgrpc\b/i, label: 'gRPC' },
];

function slugifyId(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'module'
  );
}

function extractStackFromText(text: string, repoProfile?: RepositoryProfile): string[] {
  const found = new Set<string>();
  for (const lang of repoProfile?.languages ?? []) found.add(lang);
  for (const fw of repoProfile?.frameworks ?? []) found.add(fw);
  for (const pat of KNOWN_STACK_PATTERNS) {
    if (pat.re.test(text)) found.add(pat.label);
  }
  return [...found];
}

function extractCandidateModulesFromGoal(goal: string): LivingPlanModule[] {
  // Look for explicit comma / "e" / "and" / "com" / "with" capability lists in the user's goal
  // without assuming ANY specific domain (never hardcoded to backend/frontend!).
  const clauseMatch =
    /\b(?:com|with|incluindo|including|m[óo]dulos?|modules?|componentes?|components?|partes?|parts?)\s*[:-]?\s*([^.\n]{8,220})/i.exec(
      goal,
    );
  const rawNames: string[] = [];
  if (clauseMatch) {
    const parts = clauseMatch[1]
      .split(/,|;|\s+(?:e|and|plus|\+)\s+/i)
      .map((s) => s.replace(/^(?:um|uma|o|a|os|as|the|an?)\s+/i, '').trim())
      .filter((s) => s.length >= 3 && s.length <= 48);
    for (const p of parts) {
      if (rawNames.length < 5) rawNames.push(p);
    }
  }

  if (rawNames.length >= 2) {
    const seenIds = new Set<string>();
    return rawNames.map((name) => {
      let id = slugifyId(name);
      while (seenIds.has(id)) id = `${id}-2`;
      seenIds.add(id);
      return {
        id,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        responsibility: `Implement ${name} cleanly against the shared contracts with unit tests.`,
        scope: [`src/${id}/**`, `tests/${id}/**`],
        dependsOn: ['foundation'],
      };
    });
  }

  // Domain-agnostic fallback decomposition (core domain + interfaces/adapters + workflows)
  return [
    {
      id: 'core',
      name: 'Core Domain & Business Logic',
      responsibility: 'Core domain models, state transitions, validation rules, and unit tests.',
      scope: ['src/core/**', 'tests/core/**'],
      dependsOn: ['foundation'],
    },
    {
      id: 'adapters',
      name: 'External Interfaces & Persistence',
      responsibility: 'Storage, transport/UI/CLI entrypoints, and external boundary adapters.',
      scope: ['src/adapters/**', 'tests/adapters/**'],
      dependsOn: ['foundation'],
    },
    {
      id: 'workflows',
      name: 'Orchestration & Entrypoints',
      responsibility: 'End-to-end use-case wiring, configuration, and user-facing flows.',
      scope: ['src/workflows/**', 'tests/workflows/**'],
      dependsOn: ['foundation'],
    },
  ];
}

/**
 * Deterministic domain-agnostic blueprint builder (used when offline or in tests).
 */
export function buildDeterministicLivingPlan(
  goal: string,
  repoProfile?: RepositoryProfile,
): LivingPlan {
  const now = new Date().toISOString();
  const stack = extractStackFromText(goal, repoProfile);
  const modules = extractCandidateModulesFromGoal(goal);
  const shortTitle = goal
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72)
    .replace(/[.?!]+$/, '');

  return {
    version: 1,
    title: shortTitle || 'Project Living Plan',
    goal: goal.trim(),
    stack: stack.length > 0 ? stack : ['Auto-selected by Wave 1 Foundation (confirm or refine before running)'],
    architectureNotes: [
      'Domain-agnostic modular boundaries: every parallel module owns a disjoint directory scope.',
      'Wave 2 re-scans actual files created in Wave 1 before spawning parallel multi-agent tasks.',
    ],
    contracts: [
      'Shared types, schemas, and module interfaces live in `src/contracts/` (established in Wave 1).',
      'Each module exposes a clean public barrel/interface and ships its own isolated tests.',
    ],
    modules,
    waves: [
      {
        number: 1,
        name: 'Foundation & Shared Contracts',
        mode: 'sequential',
        status: 'pending',
        objective: `Establish repository directory topology, build/test tooling, and shared contracts/interfaces required for: ${goal.trim()}`,
        modules: [],
        acceptanceCriteria: [
          'Directory layout and project manifest/build/test config are initialized and passing',
          'Shared types/contracts between modules are defined cleanly',
          'All planned module directories exist as clear ownership boundaries for Wave 2',
        ],
      },
      {
        number: 2,
        name: 'Parallel Module Implementation',
        mode: 'parallel',
        status: 'pending',
        objective: `Implement independent modules in parallel against the actual files and contracts created in Wave 1: ${modules.map((m) => m.name).join(', ')}.`,
        modules: modules.map((m) => m.id),
        acceptanceCriteria: [
          'Every module implements its assigned responsibility within its disjoint scope',
          'Module-level tests pass independently without cross-scope conflicts',
        ],
      },
      {
        number: 3,
        name: 'Integration & End-to-End Verification',
        mode: 'sequential',
        status: 'pending',
        objective: `Wire all Wave 2 modules together, add end-to-end tests and usage documentation, and verify the complete solution for: ${goal.trim()}`,
        modules: [],
        acceptanceCriteria: [
          'All modules integrate cleanly with zero broken imports or contract mismatches',
          'Full test suite, typecheck, and build pass end-to-end',
        ],
      },
    ],
    isGreenfield: Boolean(repoProfile?.isGreenfield),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Generates a domain-agnostic Living Plan blueprint using an injected generator,
 * OpenAI JSON-mode when configured, or the clean deterministic builder offline.
 */
export async function generateLivingPlanBlueprint(
  goal: string,
  options: GenerateLivingPlanOptions = {},
): Promise<LivingPlan> {
  if (options.generator) {
    try {
      const custom = await options.generator({ goal, repoProfile: options.repoProfile });
      if (custom && custom.waves.length > 0) return custom;
    } catch {
      // fall through
    }
  }

  if (options.openAiApiKey && !process.env.VITEST) {
    try {
      const baseUrl = (options.openAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
      const model = options.openAiModel ?? 'gpt-4o-mini';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.openAiApiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content:
                  'You design domain-agnostic phased software blueprints for multi-agent wave execution. Never assume "backend/frontend" unless the goal actually calls for them; adapt modules to the actual domain (CLI, library, compiler, pipeline, web app, mobile app, etc.). Return strict JSON matching: { title, stack: string[], architectureNotes: string[], contracts: string[], modules: [{ id, name, responsibility, scope: string[], dependsOn: string[] }], waves: [{ number, name, mode: "sequential"|"parallel", objective, modules: string[], acceptanceCriteria: string[] }] }. Wave 1 MUST be sequential Foundation & Contracts; Wave 2 MUST be parallel fan-out across modules with strictly disjoint directory scopes; Wave 3 MUST be Integration & E2E verification.',
              },
              {
                role: 'user',
                content: [
                  `Goal: ${goal}`,
                  options.repoProfile
                    ? `Repository profile: ${options.repoProfile.summary} (greenfield=${Boolean(options.repoProfile.isGreenfield)})`
                    : 'Repository profile: unknown',
                  options.repoProfile?.repositoryMap?.length
                    ? `Current repository map:\n${options.repoProfile.repositoryMap.slice(0, 20).join('\n')}`
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            ],
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const content = data.choices?.[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content) as Partial<LivingPlan>;
            if (Array.isArray(parsed.waves) && parsed.waves.length >= 2) {
              const now = new Date().toISOString();
              return {
                version: 1,
                title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : goal.slice(0, 72),
                goal: goal.trim(),
                stack: Array.isArray(parsed.stack) ? parsed.stack.map(String) : [],
                architectureNotes: Array.isArray(parsed.architectureNotes)
                  ? parsed.architectureNotes.map(String)
                  : [],
                contracts: Array.isArray(parsed.contracts) ? parsed.contracts.map(String) : [],
                modules: Array.isArray(parsed.modules) ? parsed.modules : [],
                waves: parsed.waves.map((w, idx) => ({
                  number: typeof w.number === 'number' ? w.number : idx + 1,
                  name: typeof w.name === 'string' ? w.name : `Wave ${idx + 1}`,
                  mode: w.mode === 'parallel' ? 'parallel' : 'sequential',
                  status: 'pending' as const,
                  objective: typeof w.objective === 'string' ? w.objective : '',
                  modules: Array.isArray(w.modules) ? w.modules.map(String) : [],
                  acceptanceCriteria: Array.isArray(w.acceptanceCriteria)
                    ? w.acceptanceCriteria.map(String)
                    : [],
                })),
                isGreenfield: Boolean(options.repoProfile?.isGreenfield),
                createdAt: now,
                updatedAt: now,
              };
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // fall through to deterministic builder
    }
  }

  return buildDeterministicLivingPlan(goal, options.repoProfile);
}

/**
 * Applies conversational refinement feedback to an existing Living Plan
 * (stack tweaks, adding/removing modules, or extra architecture constraints).
 */
export async function refineLivingPlan(
  plan: LivingPlan,
  feedback: string,
  options: GenerateLivingPlanOptions = {},
): Promise<LivingPlan> {
  if (options.generator) {
    try {
      const custom = await options.generator({
        goal: plan.goal,
        repoProfile: options.repoProfile,
        existingPlan: plan,
        feedback,
      });
      if (custom && custom.waves.length > 0) return custom;
    } catch {
      // fall through
    }
  }

  const now = new Date().toISOString();
  const updated: LivingPlan = {
    ...plan,
    stack: [...plan.stack],
    architectureNotes: [...plan.architectureNotes],
    contracts: [...plan.contracts],
    modules: plan.modules.map((m) => ({ ...m, scope: [...m.scope], dependsOn: [...m.dependsOn] })),
    waves: plan.waves.map((w) => ({ ...w, modules: [...w.modules], acceptanceCriteria: [...w.acceptanceCriteria] })),
    updatedAt: now,
  };

  // Detect any newly mentioned stack items
  const addedStack = extractStackFromText(feedback);
  if (addedStack.length > 0) {
    const cleaned = updated.stack.filter((s) => !s.startsWith('Auto-selected'));
    for (const s of addedStack) {
      if (!cleaned.includes(s)) cleaned.push(s);
    }
    updated.stack = cleaned;
  }

  // Detect explicit "add module <name>" / "adiciona módulo <name>"
  const addModRe =
    /\b(?:adiciona(?:r)?|acrescenta(?:r)?|inclui(?:r)?|add|include)\s+(?:um\s+|o\s+|a\s+)?(?:m[óo]dulo|module|componente|component)\s+(?:de\s+|for\s+|called\s+)?([a-zA-Z0-9À-ÿ_\- ]{2,40})/gi;
  let m: RegExpExecArray | null;
  while ((m = addModRe.exec(feedback)) !== null) {
    const rawName = m[1].split(/,|;|\be\b|\band\b/i)[0].trim();
    if (!rawName) continue;
    const id = slugifyId(rawName);
    if (!updated.modules.some((mod) => mod.id === id)) {
      updated.modules.push({
        id,
        name: rawName.charAt(0).toUpperCase() + rawName.slice(1),
        responsibility: `Implement ${rawName} cleanly against shared contracts with tests.`,
        scope: [`src/${id}/**`, `tests/${id}/**`],
        dependsOn: ['foundation'],
      });
      const parallelWave = updated.waves.find((w) => w.mode === 'parallel');
      if (parallelWave && !parallelWave.modules.includes(id)) {
        parallelWave.modules.push(id);
      }
    }
  }

  // Detect explicit "remove module <name>" / "remove <name>"
  const remModRe =
    /\b(?:remov(?:e|er)|tira(?:r)?|exclui(?:r)?|drop)\s+(?:o\s+|a\s+)?(?:m[óo]dulo\s+(?:de\s+)?|module\s+)?([a-zA-Z0-9À-ÿ_-]{2,32})/gi;
  while ((m = remModRe.exec(feedback)) !== null) {
    const needle = slugifyId(m[1]);
    const beforeLen = updated.modules.length;
    updated.modules = updated.modules.filter(
      (mod) => mod.id !== needle && !slugifyId(mod.name).includes(needle),
    );
    if (updated.modules.length < beforeLen) {
      const validIds = new Set(updated.modules.map((mod) => mod.id));
      for (const w of updated.waves) {
        w.modules = w.modules.filter((id) => validIds.has(id));
      }
    }
  }

  updated.architectureNotes.push(`Refinement: ${feedback.trim()}`);
  return updated;
}

/**
 * Builds the concrete, live-repository-aware execution goal for a specific Wave
 * so Wave 2+ plans directly against the ACTUAL files created in earlier waves.
 */
export function buildWaveExecutionGoal(
  plan: LivingPlan,
  wave: LivingPlanWave,
  liveRepoProfile?: RepositoryProfile,
): string {
  const sections: string[] = [
    `[Living Plan — Wave ${wave.number}/${plan.waves.length}: ${wave.name}]`,
    `Project goal: ${plan.goal}`,
    `Wave objective: ${wave.objective}`,
  ];

  if (plan.stack.length > 0) {
    sections.push(`Stack: ${plan.stack.join(', ')}`);
  }

  if (plan.contracts.length > 0) {
    sections.push(`Shared contracts:\n${plan.contracts.map((c) => `- ${c}`).join('\n')}`);
  }

  if (wave.mode === 'parallel' && wave.modules.length > 0) {
    const waveModules = wave.modules
      .map((id) => plan.modules.find((m) => m.id === id))
      .filter((m): m is LivingPlanModule => Boolean(m));
    if (waveModules.length > 0) {
      sections.push(
        `Parallel fan-out requirement: create independent parallel tasks (one per module below) with strictly disjoint allowedScope boundaries so multiple agents run simultaneously without conflicts:\n` +
          waveModules
            .map(
              (m) =>
                `- Module "${m.name}" (${m.id}) | allowedScope: [${m.scope.join(', ')}] | ${m.responsibility}`,
            )
            .join('\n'),
      );
    }
  } else if (wave.number === 1 && plan.modules.length > 0) {
    sections.push(
      `Planned Wave 2 module boundaries (prepare directory layout & shared contracts now so Wave 2 can parallelize cleanly):\n` +
        plan.modules.map((m) => `- ${m.name} (${m.id}): ${m.scope.join(', ')}`).join('\n'),
    );
  }

  const completedWaves = plan.waves.filter((w) => w.number < wave.number && w.status === 'completed');
  if (completedWaves.length > 0) {
    sections.push(
      `Completed earlier waves:\n` +
        completedWaves
          .map((w) => `- Wave ${w.number} (${w.name}): ${w.summary || 'completed'}`)
          .join('\n'),
    );
  }

  if (liveRepoProfile?.repositoryMap && liveRepoProfile.repositoryMap.length > 0) {
    sections.push(
      `Live repository layout observed right now (plan scopes strictly against these real paths):\n${liveRepoProfile.repositoryMap.slice(0, 25).join('\n')}`,
    );
  }

  if (wave.acceptanceCriteria.length > 0) {
    sections.push(
      `Wave acceptance criteria:\n${wave.acceptanceCriteria.map((ac) => `- ${ac}`).join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

const MODULE_SCOPE_ALIASES: Record<string, readonly string[]> = {
  ui: ['ui', 'frontend', 'web', 'client'],
  frontend: ['frontend', 'web', 'ui', 'client'],
  web: ['web', 'frontend', 'ui'],
  auth: ['auth', 'authentication', 'identity'],
  notifications: ['notifications', 'notification', 'alerts', 'messaging'],
  appointments: ['appointments', 'bookings', 'reservations', 'scheduling'],
  bookings: ['bookings', 'appointments', 'reservations'],
  reservations: ['reservations', 'bookings', 'appointments'],
  tests: ['tests', 'test', '__tests__'],
};

/**
 * Reconciles greenfield placeholder scopes (like `["auth", "user"]` or
 * `["notifications"]` or `["ui"]`) against the real directory topology created
 * in earlier waves (such as `src/worker/auth/`, `src/worker/notifications/`,
 * `src/web/`, `tests/unit/`), while keeping scopes strictly disjoint from
 * sibling modules in the same parallel wave.
 */
export function reconcileModuleScopeWithRepo(
  mod: LivingPlanModule,
  waveModules: readonly LivingPlanModule[],
  liveRepoProfile?: RepositoryProfile,
): string[] {
  const baseScopes =
    mod.scope.length > 0 ? [...mod.scope] : [`src/${mod.id}/**`, `tests/${mod.id}/**`];
  const rawMap = liveRepoProfile?.repositoryMap ?? [];
  if (rawMap.length === 0) return baseScopes;

  // Parse directory paths out of `buildRepositoryMap()` entries ("src/worker/auth/ — 1 files (...)").
  const repoDirs: string[] = [];
  for (const line of rawMap) {
    const match = /^([^\s(][^—]*?)\/\s+—/.exec(line.trim());
    if (match?.[1]) {
      repoDirs.push(match[1].replace(/\/+$/, ''));
    }
  }
  if (repoDirs.length === 0) return baseScopes;

  // Directories explicitly owned by sibling modules in the same wave must never be claimed here.
  const siblingTokens = new Set<string>();
  for (const sibling of waveModules) {
    if (sibling.id === mod.id) continue;
    for (const s of sibling.scope) {
      const clean = s.replace(/\/\*\*$/, '').replace(/\/+$/, '').toLowerCase();
      if (!clean) continue;
      siblingTokens.add(clean);
      const last = clean.split('/').pop();
      if (last) siblingTokens.add(last);
    }
  }

  const expanded: string[] = [...baseScopes];
  const addScope = (pattern: string) => {
    if (!expanded.includes(pattern)) expanded.push(pattern);
  };

  const hasTestsDir = repoDirs.some((d) => d === 'tests' || d.startsWith('tests/'));
  const hasUnitTestsDir = repoDirs.some((d) => d === 'tests/unit' || d.startsWith('tests/unit/'));

  for (const raw of baseScopes) {
    const clean = raw.replace(/\/\*\*$/, '').replace(/\/+$/, '');
    if (!clean || clean.includes('*') || clean.includes('/')) continue;

    const lower = clean.toLowerCase();
    const candidates = MODULE_SCOPE_ALIASES[lower] ?? [lower];
    const matchedParents = new Set<string>();

    for (const dir of repoDirs) {
      const segments = dir.toLowerCase().split('/');
      const lastSeg = segments[segments.length - 1];
      if (siblingTokens.has(dir.toLowerCase()) || siblingTokens.has(lastSeg)) continue;

      if (candidates.includes(lastSeg)) {
        matchedParents.add(dir);
        continue;
      }

      // Collapse nested directories like `src/web/app`, `src/web/pages` into `src/web` when `web` is an alias.
      for (let idx = 0; idx < segments.length - 1; idx += 1) {
        const seg = segments[idx];
        if (candidates.includes(seg) && !siblingTokens.has(seg)) {
          const parentPath = dir.split('/').slice(0, idx + 1).join('/');
          matchedParents.add(parentPath);
          break;
        }
      }
    }

    for (const parentDir of [...matchedParents].sort()) {
      addScope(`${parentDir}/**`);
    }

    if (lower !== 'tests' && lower !== 'test') {
      if (hasUnitTestsDir) addScope(`tests/unit/${lower}/**`);
      if (hasTestsDir) addScope(`tests/${lower}/**`);
    }
  }

  // Collapse redundant child globs when an ancestor glob (`src/web/**`) is already present.
  const globRoots = expanded
    .filter((s) => s.endsWith('/**'))
    .map((s) => s.slice(0, -3));
  return expanded.filter((entry) => {
    if (!entry.endsWith('/**')) return true;
    const root = entry.slice(0, -3);
    return !globRoots.some((other) => other !== root && root.startsWith(`${other}/`));
  });
}

/**
 * Deterministically compiles a parallel Living Plan Wave (e.g. Wave 2) directly
 * into a multi-task `TaskGraph` where each module becomes an independent task
 * with strictly disjoint `allowedScope` boundaries. Guarantees real multi-agent
 * parallel fan-out even with zero OpenAI API key!
 */
export function compileWaveToTaskGraph(
  plan: LivingPlan,
  wave: LivingPlanWave,
  goalId: string,
  liveRepoProfile?: RepositoryProfile,
): TaskGraph | undefined {
  if (wave.mode !== 'parallel' || wave.modules.length < 2) return undefined;

  const waveModules = wave.modules
    .map((id) => plan.modules.find((m) => m.id === id))
    .filter((m): m is LivingPlanModule => Boolean(m));
  if (waveModules.length < 2) return undefined;

  const tasks: Task[] = [];
  const moduleIdToTaskId = new Map<string, string>();
  waveModules.forEach((mod, idx) => {
    moduleIdToTaskId.set(mod.id, `TASK-${String(idx + 1).padStart(2, '0')}`);
  });

  const liveMapBlock =
    liveRepoProfile?.repositoryMap && liveRepoProfile.repositoryMap.length > 0
      ? `\nObserved repository layout:\n${liveRepoProfile.repositoryMap.slice(0, 20).join('\n')}`
      : '';
  const contractsBlock =
    plan.contracts.length > 0
      ? `\nShared contracts to honor:\n${plan.contracts.map((c) => `- ${c}`).join('\n')}`
      : '';

  const now = new Date();
  for (let i = 0; i < waveModules.length; i++) {
    const mod = waveModules[i];
    const taskId = moduleIdToTaskId.get(mod.id)!;
    const intraWaveDeps = mod.dependsOn
      .map((dep) => moduleIdToTaskId.get(dep))
      .filter((depTaskId): depTaskId is string => Boolean(depTaskId) && depTaskId !== taskId);

    const allowedScope = reconcileModuleScopeWithRepo(mod, waveModules, liveRepoProfile);
    const criteria = [
      `Implement ${mod.name} cleanly within [${allowedScope.join(', ')}]`,
      'Include unit tests covering the core behavior and edge cases',
      'Honor shared contracts without modifying sibling module scopes',
    ];
    const task: Task = {
      id: taskId,
      goalId,
      title: `Implement ${mod.name}`,
      description: `${mod.responsibility} (Wave ${wave.number}: ${wave.name})`,
      type: 'implementation',
      status: 'proposed',
      dependencies: intraWaveDeps,
      acceptanceCriteria: criteria,
      contract: {
        objective: [
          `[Living Plan Wave ${wave.number} — Module: ${mod.name}]`,
          `Project goal: ${plan.goal}`,
          `Module responsibility: ${mod.responsibility}`,
          plan.stack.length > 0 ? `Stack: ${plan.stack.join(', ')}` : '',
          contractsBlock,
          liveMapBlock,
        ]
          .filter(Boolean)
          .join('\n'),
        allowedScope,
        forbiddenChanges: [],
        acceptanceCriteria: criteria,
        dependencies: intraWaveDeps,
        completionMode: 'mutation',
        metadata: {
          livingPlanWave: wave.number,
          livingPlanModuleId: mod.id,
        },
      },
      reworkCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(task);
  }

  return new TaskGraph(tasks, {
    goalId,
    planner: {
      source: 'deterministic_decomposition',
      model: 'living-plan-wave-compiler',
      livingPlanWave: wave.number,
    },
  });
}

/** Formats a Living Plan cleanly for display inside the interactive REPL. */
export function formatLivingPlanDisplay(
  plan: LivingPlan,
  options: { savedPath?: string; interactivePrompt?: boolean } = {},
): string {
  const nextWave = getNextPendingWave(plan);
  const completedCount = plan.waves.filter((w) => w.status === 'completed').length;
  const lines: string[] = [
    `${colors.brand}✦ ${colors.bold}Living Plan — ${plan.title}${colors.reset} ${colors.dim}(${completedCount}/${plan.waves.length} waves complete${plan.isGreenfield ? ' · greenfield' : ''})${colors.reset}`,
  ];
  if (options.savedPath) {
    lines.push(`  ${colors.dim}Saved to ${options.savedPath} (editable anytime)${colors.reset}`);
  }
  if (plan.stack.length > 0) {
    lines.push(`  ${colors.cyan}Stack:${colors.reset} ${plan.stack.join(', ')}`);
  }
  if (plan.contracts.length > 0) {
    lines.push(`  ${colors.cyan}Contracts:${colors.reset} ${plan.contracts[0]}`);
  }
  if (plan.modules.length > 0) {
    lines.push('', `  ${colors.bold}Modules:${colors.reset}`);
    for (const mod of plan.modules) {
      lines.push(
        `    • ${colors.bold}${mod.name}${colors.reset} ${colors.dim}[${mod.scope.join(', ')}]${colors.reset} — ${mod.responsibility}`,
      );
    }
  }

  lines.push('', `  ${colors.bold}Waves:${colors.reset}`);
  for (const wave of plan.waves) {
    const icon =
      wave.status === 'completed'
        ? `${colors.green}✔${colors.reset}`
        : wave.status === 'in_progress'
          ? `${colors.cyan}●${colors.reset}`
          : wave.status === 'failed'
            ? `${colors.red}✖${colors.reset}`
            : `${colors.dim}○${colors.reset}`;
    const modeBadge =
      wave.mode === 'parallel'
        ? `${colors.cyan}parallel${colors.reset}`
        : `${colors.dim}sequential${colors.reset}`;
    const nextTag = nextWave?.number === wave.number ? ` ${colors.green}← next${colors.reset}` : '';
    lines.push(
      `    ${icon} ${colors.bold}Wave ${wave.number}: ${wave.name}${colors.reset} ${colors.dim}(${modeBadge}${colors.dim})${colors.reset}${nextTag}`,
    );
    lines.push(`      ${colors.dim}${wave.objective.slice(0, 140)}${wave.objective.length > 140 ? '…' : ''}${colors.reset}`);
  }

  if (nextWave && options.interactivePrompt) {
    lines.push(
      '',
      `  ${colors.dim}↵ Enter: start Wave ${nextWave.number} (${nextWave.name})   ·   type refinements to adjust the blueprint   ·   /blueprint reset to discard   ·   /back to pause${colors.reset}`,
    );
  } else if (nextWave) {
    lines.push(
      '',
      `  ${colors.dim}Run /blueprint next (or "próxima wave") to launch Wave ${nextWave.number}: ${nextWave.name}.${colors.reset}`,
    );
  } else {
    lines.push('', `  ${colors.green}✔ All waves in .taskforge/plan.md are complete!${colors.reset}`);
  }

  return lines.join('\n');
}
