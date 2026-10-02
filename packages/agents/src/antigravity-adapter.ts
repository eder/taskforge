import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentResult,
} from '@taskforge/shared';
import { AgentQuotaTracker } from './quota-tracker.js';

import { BaseCliAdapter, CliAdapterOptions } from './base-cli-adapter.js';

export class AntigravityAdapter extends BaseCliAdapter {
  readonly id = 'agy';
  readonly name = 'Google Antigravity';
  readonly binaryName = 'agy';
  readonly stdinMode = 'interactive';
  readonly permissionProtocol = 'structured';

  protected providerEnvAllow(): string[] {
    return ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  }

  constructor(options: CliAdapterOptions = {}) {
    AntigravityAdapter.ensurePrerequisites();
    const defaultArgs =
      options.defaultArgs && options.defaultArgs.length > 0
        ? options.defaultArgs
        : ['--output-format', 'stream-json', '-p'];
    super({
      ...options,
      defaultArgs,
    });
  }

  public static recoverQuotaFromRecentLogs(customHome?: string): boolean {
    const tracker = AgentQuotaTracker.getInstance();
    if (!tracker.isAvailable('agy')) return true;

    try {
      const home = customHome || process.env.HOME || os.homedir();
      const logDir = path.join(home, '.gemini', 'antigravity-cli', 'log');
      if (!fs.existsSync(logDir)) return false;

      const files = fs
        .readdirSync(logDir)
        .filter((name) => name.endsWith('.log'))
        .map((name) => {
          const fullPath = path.join(logDir, name);
          return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 8);

      for (const file of files) {
        const raw = fs.readFileSync(file.fullPath, 'utf8');
        const tail = raw.slice(-131_072);
        const quotaLine = tail
          .split('\n')
          .reverse()
          .find((line) =>
            /RESOURCE_EXHAUSTED|individual quota reached|quota (?:reached|exceeded)/i.test(line),
          );

        if (!quotaLine) continue;
        tracker.recordFailure('agy', quotaLine, file.mtimeMs);
        if (!tracker.isAvailable('agy')) return true;
      }
    } catch {
      // Best-effort recovery: inability to read provider logs must never block startup.
    }

    return false;
  }

  public static ensurePrerequisites(worktreeOrRepoPath?: string, customHome?: string): void {
    try {
      const home = customHome || process.env.HOME || os.homedir();
      const settingsDir = path.join(home, '.gemini', 'antigravity-cli');
      const settingsFile = path.join(settingsDir, 'settings.json');

      let settings: {
        permissions?: {
          allow?: string[];
          deny?: string[];
        };
        trustedWorkspaces?: string[];
        [key: string]: unknown;
      } = {};

      if (fs.existsSync(settingsFile)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        } catch {
          settings = {};
        }
      } else {
        fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
      }

      if (!settings.permissions) {
        settings.permissions = {};
      }
      if (!Array.isArray(settings.permissions.allow)) {
        settings.permissions.allow = [];
      }

      const requiredRules = [
        'read_file(*)',
        'write_file(*)',
        'edit_file(*)',
        'command(*)',
        'read_url(*)',
      ];

      let modified = false;
      for (const rule of requiredRules) {
        if (!settings.permissions.allow.includes(rule)) {
          settings.permissions.allow.unshift(rule);
          modified = true;
        }
      }

      if (worktreeOrRepoPath) {
        if (!Array.isArray(settings.trustedWorkspaces)) {
          settings.trustedWorkspaces = [];
        }
        const resolvedPath = path.resolve(worktreeOrRepoPath);
        if (!settings.trustedWorkspaces.includes(resolvedPath)) {
          settings.trustedWorkspaces.push(resolvedPath);
          modified = true;
        }
        const match = resolvedPath.match(/(.*?)\/\.taskforge\/worktrees/);
        if (match && match[1] && !settings.trustedWorkspaces.includes(match[1])) {
          settings.trustedWorkspaces.push(match[1]);
          modified = true;
        }
      }

      if (modified || !fs.existsSync(settingsFile)) {
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
    } catch {
      // ignore if settings directory or file is not writable
    }
  }

  async detect(): Promise<boolean> {
    AntigravityAdapter.ensurePrerequisites();
    AntigravityAdapter.recoverQuotaFromRecentLogs();
    return super.detect();
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    AntigravityAdapter.ensurePrerequisites(context.worktreePath);
    return super.execute(assignment, context);
  }

  async capabilities(): Promise<AgentCapabilities> {
    const base = await super.capabilities();
    return {
      ...base,
      stdinMode: 'interactive',
      permissionProtocol: 'structured',
      questionProtocol: 'structured',
    };
  }
}
