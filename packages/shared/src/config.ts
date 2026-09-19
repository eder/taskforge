import { z } from 'zod';
import * as yaml from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigurationError } from './errors.js';

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxParallel: z.number().int().positive().default(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
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
  agents: z
    .record(AgentConfigSchema)
    .default({
      claude: { enabled: true, maxParallel: 1 },
      codex: { enabled: true, maxParallel: 2 },
      gemini: { enabled: true, maxParallel: 1 },
    }),
  verification: z
    .object({
      tests: z.boolean().default(true),
      lint: z.boolean().default(true),
      typecheck: z.boolean().default(true),
      review: z.boolean().default(true),
      maxReworkCycles: z.number().int().nonnegative().default(2),
    })
    .default({
      tests: true,
      lint: true,
      typecheck: true,
      review: true,
      maxReworkCycles: 2,
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
});

export type TaskForgeConfig = z.infer<typeof TaskForgeConfigSchema>;

export function getDefaultConfig(): TaskForgeConfig {
  return TaskForgeConfigSchema.parse({});
}

export function loadConfig(configPath?: string): TaskForgeConfig {
  const resolvedPath = configPath ?? path.resolve(process.cwd(), '.taskforge/config.yaml');
  if (!fs.existsSync(resolvedPath)) {
    return getDefaultConfig();
  }

  try {
    const rawContent = fs.readFileSync(resolvedPath, 'utf8');
    const parsedYaml = yaml.parse(rawContent);
    return TaskForgeConfigSchema.parse(parsedYaml ?? {});
  } catch (error) {
    throw new ConfigurationError(`Failed to load config from ${resolvedPath}: ${(error as Error).message}`, {
      path: resolvedPath,
      error,
    });
  }
}
