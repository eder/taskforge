import { z } from 'zod';
import * as yaml from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigurationError } from './errors.js';

/** Single source of truth for `git.workflow`; also used to validate `/workflow`. */
export const GIT_WORKFLOW_KINDS = ['trunk', 'github-flow', 'gitflow', 'current-branch'] as const;

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxParallel: z.number().int().positive().default(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  /** Names of extra parent-environment variables to forward to this agent (e.g. SSH_AUTH_SOCK). */
  passEnv: z.array(z.string()).optional(),
});

const OwnershipRuleSchema = z.object({
  scope: z.string().min(1),
  writers: z.array(z.string().min(1)).min(1),
});

/** Words that mark a task as sensitive when dual review is enabled. */
export const DEFAULT_DUAL_REVIEW_KEYWORDS = [
  'authentication',
  'authorization',
  'password',
  'credential',
  'secret',
  'encryption',
  'payment',
  'billing',
  'schema migration',
  'database migration',
  'security',
];

const DualReviewSchema = z.object({
  /** Opt-in: sensitive tasks need an independent agent's approval before integration. */
  enabled: z.boolean().default(false),
  /** Task scopes (same glob rules as ownership) that are always sensitive, e.g. "db/migrations/**". */
  scopes: z.array(z.string().min(1)).default([]),
  /** Keywords in a task's title/objective that make it sensitive. */
  keywords: z.array(z.string().min(1)).default(DEFAULT_DUAL_REVIEW_KEYWORDS),
  /** What to do when no healthy agent other than the implementer(s) can review. */
  onNoIndependentReviewer: z.enum(['block', 'skip']).default('block'),
});

const ScopedVerificationRuleSchema = z.object({
  scope: z.string().min(1),
  commands: z.array(z.string().min(1)).min(1),
});

export const TaskForgeConfigSchema = z.object({
  version: z.number().default(1),
  ui: z
    .object({
      mode: z.enum(['interactive', 'headless']).default('interactive'),
    })
    .default({ mode: 'interactive' }),
  planner: z
    .object({
      agent: z.string().default('claude'),
      /** The planner is asked for at most this many tasks; tests and docs belong inside the task that changes the code. */
      maxTasks: z.number().int().positive().default(6),
      /**
       * With no OpenAI key, plan with the user's own coding agent (read-only). `auto` skips it for
       * small goals, because it costs tens of thousands of tokens per plan; `never` always uses the
       * built-in plan.
       */
      agentPlanning: z.enum(['auto', 'always', 'never']).default('auto'),
    })
    .default({ agent: 'claude', maxTasks: 6, agentPlanning: 'auto' }),
  router: z
    .object({
      provider: z.enum(['openai', 'static', 'adaptive']).default('openai'),
      model: z.string().default('gpt-5.6-luna'),
      escalationModel: z.string().default('gpt-5.6-terra'),
      fallback: z.enum(['static']).default('static'),
      adaptive: z.boolean().default(false),
      apiKey: z.string().optional(),
      /** How long the planner waits for the model before falling back to a simpler plan. */
      timeoutSeconds: z.number().int().positive().default(60),
    })
    .default({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      escalationModel: 'gpt-5.6-terra',
      fallback: 'static',
      adaptive: false,
    }),
  execution: z
    .object({
      maxParallelTasks: z.number().int().positive().default(3),
      defaultTimeoutMinutes: z.number().positive().default(30),
      worktreesDir: z.string().default('.taskforge/worktrees'),
      databasePath: z.string().default('.taskforge/taskforge.db'),
      runsDir: z.string().default('.taskforge/runs'),
      /**
       * Opt-in age-based cleanup (e.g. "7d") of stale TaskForge worktrees and
       * temporary branches, run at the start of every new run.
       */
      /**
       * Gitignored dependency directories symlinked from the main checkout into
       * every worktree, so verification (tests/lint/typecheck) can run without
       * a per-worktree install. Supports "*" for one path segment, e.g.
       * "packages/*\/node_modules". Use [] to disable.
       */
      worktreeLinks: z.array(z.string().min(1)).default(['node_modules', 'packages/*/node_modules', 'apps/*/node_modules']),
      /**
       * Maximum provider-reported tokens a run may spend (all attempts of the
       * run, including after `tf resume`). No new task is started once it is
       * reached; tasks already running finish, so a run can overshoot by what
       * was in flight. 0 = no cap. The default is generous on purpose: it only
       * stops a runaway run, so a new user never has unlimited spend by accident.
       */
      tokenBudget: z.number().int().min(0).default(2_000_000),
      /**
       * How much staffing and spend a run may use. `economy` (the default when loading a
       * project's config): one agent per task and a 1M-token cap. `standard`: an author and a
       * reviewer, 2M. `thorough`: up to three agents, 4M. Any value set explicitly below
       * (collaboration.maxAgentsPerTask, execution.tokenBudget) wins over the profile.
       */
      profile: z.enum(['economy', 'standard', 'thorough']).optional(),
      autoPruneOlderThan: z
        .string()
        .regex(/^\d+[smhdw]$/, 'Use a number plus s, m, h, d or w (e.g. 7d)')
        .optional(),
    })
    .default({
      maxParallelTasks: 3,
      defaultTimeoutMinutes: 30,
      worktreesDir: '.taskforge/worktrees',
      databasePath: '.taskforge/taskforge.db',
      runsDir: '.taskforge/runs',
    }),
  collaboration: z
    .object({
      maxAgentsPerTask: z.number().int().positive().default(3),
      maxMessagesPerRound: z.number().int().positive().default(6),
      maxRounds: z.number().int().positive().default(3),
      /**
       * When an independent reviewer asks for changes, send them back to the
       * implementer this many times (default 1) before the task is judged. 0 = the
       * reviewer's findings are only reported.
       */
      reviewFixPasses: z.number().int().min(0).default(1),
    })
    .default({
      maxAgentsPerTask: 3,
      maxMessagesPerRound: 6,
      maxRounds: 3,
    }),
  agents: z.record(AgentConfigSchema).default({
    claude: { enabled: true, maxParallel: 1 },
    codex: { enabled: true, maxParallel: 2 },
    agy: { enabled: true, maxParallel: 1 },
  }),
  context: z
    .object({
      /** Attach the report of an earlier run when a request refers to it ("do item 1"). */
      carryOver: z.boolean().default(true),
      /** Only runs newer than this are used as context. */
      maxAgeHours: z.number().positive().default(24),
      /** Upper bound on the characters of earlier output given to the planner and agents. */
      maxChars: z.number().int().positive().default(12000),
    })
    .default({ carryOver: true, maxAgeHours: 24, maxChars: 12000 }),
  ownership: z
    .object({
      rules: z.array(OwnershipRuleSchema).default([]),
    })
    .default({ rules: [] }),
  verification: z
    .object({
      tests: z.boolean().default(true),
      lint: z.boolean().default(true),
      typecheck: z.boolean().default(true),
      review: z.boolean().default(true),
      maxReworkCycles: z.number().int().nonnegative().default(2),
      commands: z.array(z.string().min(1)).default([]),
      scopedCommands: z.array(ScopedVerificationRuleSchema).default([]),
      /** Fail tasks that modify files outside their declared allowedScope. */
      enforceScope: z.boolean().default(true),
      /** Per-command timeout for verification commands. */
      commandTimeoutSeconds: z.number().int().positive().default(600),
      /**
       * Before any agent works, run the project's check commands once on the
       * unchanged code. If they cannot run here (missing .env, service down), stop
       * before spending tokens, instead of discovering it after the work is done.
       */
      preflight: z.boolean().default(true),
      /** Extra environment variable names verification commands may see (secret-looking names are otherwise withheld). */
      passEnv: z.array(z.string()).default([]),
      dualReview: DualReviewSchema.default({}),
    })
    .default({
      tests: true,
      lint: true,
      typecheck: true,
      review: true,
      maxReworkCycles: 2,
      commands: [],
      scopedCommands: [],
    }),
  plugins: z
    .object({
      ecc: z
        .object({
          enabled: z.enum(['auto', 'always', 'never']).default('auto'),
          mode: z.enum(['selective', 'full']).default('selective'),
        })
        .default({ enabled: 'auto', mode: 'selective' }),
    })
    .default({
      ecc: { enabled: 'auto', mode: 'selective' },
    }),
  security: z
    .object({
      allowAutomaticWriteOutsideWorktree: z.boolean().default(false),
      allowAutomaticPush: z.boolean().default(false),
    })
    .default({
      allowAutomaticWriteOutsideWorktree: false,
      allowAutomaticPush: false,
    }),
  permissions: z
    .object({
      filesystem: z
        .object({
          workspace_write: z.enum(['allow', 'deny', 'ask_human']).default('allow'),
          outside_workspace: z.enum(['allow', 'deny', 'ask_human']).default('ask_human'),
          delete_files: z.enum(['allow', 'deny', 'ask_human']).default('ask_human'),
        })
        .default({
          workspace_write: 'allow',
          outside_workspace: 'ask_human',
          delete_files: 'ask_human',
        }),
      commands: z
        .object({
          tests: z.enum(['allow', 'deny', 'ask_human']).default('allow'),
          lint: z.enum(['allow', 'deny', 'ask_human']).default('allow'),
          package_install: z.enum(['allow', 'deny', 'ask_human']).default('ask_human'),
          network: z.enum(['allow', 'deny', 'ask_human']).default('ask_human'),
          sudo: z.enum(['allow', 'deny', 'ask_human']).default('deny'),
        })
        .default({
          tests: 'allow',
          lint: 'allow',
          package_install: 'ask_human',
          network: 'ask_human',
          sudo: 'deny',
        }),
      git: z
        .object({
          commit: z.enum(['allow', 'deny', 'ask_human']).default('allow'),
          push: z.enum(['allow', 'deny', 'ask_human']).default('ask_human'),
          force_push: z.enum(['allow', 'deny', 'ask_human']).default('deny'),
          merge_main: z.enum(['allow', 'deny', 'ask_human']).default('deny'),
        })
        .default({
          commit: 'allow',
          push: 'ask_human',
          force_push: 'deny',
          merge_main: 'deny',
        }),
      fallback: z.enum(['allow', 'deny', 'ask_human']).default('ask_human'),
    })
    .default({
      filesystem: {
        workspace_write: 'allow',
        outside_workspace: 'ask_human',
        delete_files: 'ask_human',
      },
      commands: {
        tests: 'allow',
        lint: 'allow',
        package_install: 'ask_human',
        network: 'ask_human',
        sudo: 'deny',
      },
      git: {
        commit: 'allow',
        push: 'ask_human',
        force_push: 'deny',
        merge_main: 'deny',
      },
      fallback: 'ask_human',
    }),
  headless: z
    .object({
      onHumanQuestion: z.enum(['block', 'fail']).default('block'),
      onUnknownPermission: z.enum(['deny', 'ask_human', 'allow']).default('deny'),
      onAuthenticationRequired: z.enum(['fail', 'block']).default('fail'),
      onConfirmationRequired: z.enum(['block', 'fail']).default('block'),
    })
    .default({
      onHumanQuestion: 'block',
      onUnknownPermission: 'deny',
      onAuthenticationRequired: 'fail',
      onConfirmationRequired: 'block',
    }),
  interactions: z
    .object({
      humanResponseTimeout: z.union([z.number(), z.string()]).default(1800000),
      onTimeout: z
        .object({
          permission: z.enum(['deny', 'allow']).default('deny'),
          question: z.enum(['block', 'fail']).default('block'),
          confirmation: z.enum(['block', 'deny']).default('block'),
        })
        .default({
          permission: 'deny',
          question: 'block',
          confirmation: 'block',
        }),
    })
    .default({
      humanResponseTimeout: 1800000,
      onTimeout: {
        permission: 'deny',
        question: 'block',
        confirmation: 'block',
      },
    }),
  delivery: z
    .object({
      mode: z
        .enum(['ask_human', 'auto_apply', 'pull_request', 'branch_only'])
        .default('ask_human'),
      targetBranch: z.string().optional(),
    })
    .default({
      mode: 'ask_human',
    }),
  git: z
    .object({
      workflow: z.enum(GIT_WORKFLOW_KINDS).default('trunk'),
      targetBranch: z.string().optional(),
      branches: z
        .object({
          production: z.string().default('main'),
          development: z.string().default('develop'),
        })
        .default({ production: 'main', development: 'develop' }),
    })
    .default({
      workflow: 'trunk',
      branches: { production: 'main', development: 'develop' },
    }),
});

export type TaskForgeConfig = z.infer<typeof TaskForgeConfigSchema>;

export function getDefaultConfig(): TaskForgeConfig {
  return TaskForgeConfigSchema.parse({});
}

export function getGlobalConfigPath(): string {
  return path.resolve(os.homedir(), '.taskforge/config.yaml');
}

/**
 * Provider availability belongs to the TaskForge installation/user, not to
 * any individual repository. Keep this control-plane state global so a quota
 * failure learned in one project is respected immediately in every project.
 */
export function getGlobalStateDatabasePath(): string {
  return path.resolve(os.homedir(), '.taskforge/state.db');
}

export function resolveOpenAIApiKey(config?: TaskForgeConfig): string | undefined {
  if (process.env.TASKFORGE_OPENAI_API_KEY && process.env.TASKFORGE_OPENAI_API_KEY.trim().length > 0) {
    return process.env.TASKFORGE_OPENAI_API_KEY.trim();
  }
  if (config?.router?.apiKey && config.router.apiKey.trim().length > 0) {
    return config.router.apiKey.trim();
  }
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) {
    return process.env.OPENAI_API_KEY.trim();
  }
  return undefined;
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...target };
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = result[key];
    if (
      sVal &&
      typeof sVal === 'object' &&
      !Array.isArray(sVal) &&
      tVal &&
      typeof tVal === 'object' &&
      !Array.isArray(tVal)
    ) {
      result[key] = deepMerge(tVal, sVal);
    } else if (sVal !== undefined) {
      result[key] = sVal;
    }
  }
  return result;
}

/** What each profile means (see `execution.profile`). */
export const EXECUTION_PROFILES = {
  economy: { maxAgentsPerTask: 1, tokenBudget: 1_000_000 },
  standard: { maxAgentsPerTask: 2, tokenBudget: 2_000_000 },
  thorough: { maxAgentsPerTask: 3, tokenBudget: 4_000_000 },
} as const;

/** Fills the settings a profile governs, unless the person set them. */
function applyProfile(merged: Record<string, any>): Record<string, any> {
  const execution = { ...(merged.execution ?? {}) };
  // A misspelt profile is left as written so validation rejects it with a clear message.
  if (execution.profile !== undefined && !(execution.profile in EXECUTION_PROFILES)) return merged;
  const profile: keyof typeof EXECUTION_PROFILES = execution.profile ?? 'economy';
  const values = EXECUTION_PROFILES[profile];
  const collaboration = { ...(merged.collaboration ?? {}) };
  if (collaboration.maxAgentsPerTask === undefined) collaboration.maxAgentsPerTask = values.maxAgentsPerTask;
  if (execution.tokenBudget === undefined) execution.tokenBudget = values.tokenBudget;
  return { ...merged, execution: { ...execution, profile }, collaboration };
}

export function loadConfig(configPath?: string): TaskForgeConfig {
  let merged: Record<string, any> = {};

  // Load global ~/.taskforge/config.yaml if using default resolution
  if (!configPath) {
    const globalPath = getGlobalConfigPath();
    if (fs.existsSync(globalPath)) {
      try {
        const rawGlobal = fs.readFileSync(globalPath, 'utf8');
        const parsedGlobal = yaml.parse(rawGlobal);
        if (parsedGlobal && typeof parsedGlobal === 'object') {
          merged = deepMerge(merged, parsedGlobal);
        }
      } catch {
        // ignore global config read error
      }
    }
  }

  const resolvedPath = configPath ?? path.resolve(process.cwd(), '.taskforge/config.yaml');
  if (fs.existsSync(resolvedPath)) {
    try {
      const rawContent = fs.readFileSync(resolvedPath, 'utf8');
      const parsedYaml = yaml.parse(rawContent);
      if (parsedYaml && typeof parsedYaml === 'object') {
        merged = deepMerge(merged, parsedYaml);
      }
    } catch (error) {
      throw new ConfigurationError(
        `Failed to load config from ${resolvedPath}: ${(error as Error).message}`,
        {
          path: resolvedPath,
          error,
        },
      );
    }
  }

  // A project with no config at all gets the same profile as one with a partial config.
  merged = applyProfile(merged);

  try {
    return TaskForgeConfigSchema.parse(merged);
  } catch (error) {
    const details =
      error instanceof z.ZodError
        ? '\n' +
          error.issues
            .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n')
        : ` ${(error as Error).message}`;
    throw new ConfigurationError(`Invalid configuration:${details}`, { error });
  }
}
