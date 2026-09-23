import { z } from 'zod';
import * as yaml from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigurationError } from './errors.js';

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxParallel: z.number().int().positive().default(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const OwnershipRuleSchema = z.object({
  scope: z.string().min(1),
  writers: z.array(z.string().min(1)).min(1),
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
    })
    .default({ agent: 'claude' }),
  router: z
    .object({
      provider: z.enum(['openai', 'static', 'adaptive']).default('openai'),
      model: z.string().default('gpt-5.6-luna'),
      escalationModel: z.string().default('gpt-5.6-terra'),
      fallback: z.enum(['static']).default('static'),
      adaptive: z.boolean().default(false),
      apiKey: z.string().optional(),
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
      workflow: z.enum(['trunk', 'github-flow', 'gitflow', 'current-branch']).default('trunk'),
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

  if (Object.keys(merged).length === 0) {
    return getDefaultConfig();
  }

  try {
    return TaskForgeConfigSchema.parse(merged);
  } catch (error) {
    throw new ConfigurationError(
      `Invalid configuration: ${(error as Error).message}`,
      { error },
    );
  }
}
