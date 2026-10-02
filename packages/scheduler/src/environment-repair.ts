import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { addToProjectConfigList, getDefaultConfig } from '@taskforge/shared';
import { ProcessRunner } from '@taskforge/execution';

/**
 * Checks that cannot run because of the environment (a missing .env, a
 * withheld secret, a database that is not up) are fixable without any agent.
 * This reads the recorded failure, works out what is missing from the project
 * itself, and applies the fix the person agreed to. Detection is deterministic:
 * it only proposes things it can point at in the repository.
 */
export type EnvironmentFix =
  | { kind: 'link_files'; paths: string[] }
  | { kind: 'pass_env'; names: string[] }
  | { kind: 'start_service'; service: string; port: number; file: string; command: string }
  | { kind: 'manual'; note: string };

const DOTENV = /^\.env(\.[\w.-]+)?$/;
const DOTENV_TEMPLATE = /(example|sample|template|dist|defaults?)$/i;
const SECRET_NAME = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\b/g;

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Gitignored dotenv files in the checkout (they exist for the developer, never in a worktree). */
export function findIgnoredDotenvFiles(repoRoot: string): string[] {
  const listed = git(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']);
  return listed
    .split('\n')
    .map((l) => l.trim())
    .filter((rel) => {
      if (!rel || rel.endsWith('/')) return false;
      const base = path.posix.basename(rel);
      return DOTENV.test(base) && !DOTENV_TEMPLATE.test(base) && rel.split('/').length <= 4;
    })
    .slice(0, 5);
}

/** The first local port a "connection refused" style failure was trying to reach. */
export function refusedPort(text: string): number | undefined {
  const patterns = [
    /\(['"]?(?:127\.0\.0\.1|localhost|::1|0\.0\.0\.0)['"]?,\s*(\d{2,5})\)/,
    /(?:127\.0\.0\.1|localhost):(\d{2,5})/,
    /\bport (\d{2,5})\b/i,
  ];
  for (const pattern of patterns) {
    const port = pattern.exec(text)?.[1];
    if (port) return Number(port);
  }
  return undefined;
}

/** A docker compose service that publishes the given host port, found by reading the compose files. */
export function findComposeServiceForPort(
  repoRoot: string,
  port: number,
): { service: string; file: string } | undefined {
  const candidates: string[] = [];
  const consider = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isFile() && /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(entry.name)) candidates.push(rel);
      else if (entry.isDirectory() && depth < 1 && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        consider(rel, depth + 1);
      }
    }
  };
  consider('', 0);

  for (const file of candidates) {
    let service: string | undefined;
    let inServices = false;
    for (const line of fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n')) {
      if (/^services:\s*$/.test(line)) {
        inServices = true;
        continue;
      }
      if (/^\S/.test(line) && !/^\s*#/.test(line)) inServices = false;
      if (!inServices) continue;
      const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
      if (svc) service = svc[1];
      const ports = /^\s*-\s*["']?(?:[\d.]+:)?(\d+):\d+/.exec(line);
      if (service && ports && Number(ports[1]) === port) return { service, file };
    }
  }
  return undefined;
}

export function diagnoseEnvironmentFailure(options: {
  repoRoot: string;
  /** The recorded reason and evidence of the failed check. */
  text: string;
  env?: NodeJS.ProcessEnv;
}): EnvironmentFix[] {
  const { repoRoot, text } = options;
  const env = options.env ?? process.env;
  const lower = text.toLowerCase();
  const fixes: EnvironmentFix[] = [];

  const needsSecrets = /api[_ ]?key|environment variable|dotenv|\.env\b|not set|unset|missing/.test(lower);
  if (needsSecrets) {
    const files = findIgnoredDotenvFiles(repoRoot);
    if (files.length > 0) fixes.push({ kind: 'link_files', paths: files });

    // A variable the failure names that exists in the person's own environment.
    const names = [...new Set([...text.matchAll(SECRET_NAME)].map((m) => m[1]))].filter((name) => env[name]);
    if (names.length > 0 && files.length === 0) fixes.push({ kind: 'pass_env', names: names.slice(0, 5) });
  }

  if (/connection refused|econnrefused|connect call failed|errno (?:61|111)|could not connect/.test(lower)) {
    const port = refusedPort(text);
    const found = port ? findComposeServiceForPort(repoRoot, port) : undefined;
    if (port && found) {
      fixes.push({
        kind: 'start_service',
        service: found.service,
        port,
        file: found.file,
        command: `docker compose -f ${found.file} up -d ${found.service}`,
      });
    } else if (port) {
      fixes.push({
        kind: 'manual',
        note: `something is expected to listen on port ${port} and is not running; no docker compose service for it was found, so start it yourself`,
      });
    }
  }
  return fixes;
}

/** Fixes TaskForge can apply on its own (the rest need a person). */
export function actionableFixes(fixes: EnvironmentFix[]): EnvironmentFix[] {
  return fixes.filter((f) => f.kind !== 'manual');
}

export function describeFix(fix: EnvironmentFix): string {
  switch (fix.kind) {
    case 'link_files':
      return `link ${fix.paths.join(', ')} into the isolated copies so the tests can load it (the agents can read it there too)`;
    case 'pass_env':
      return `let the checks see ${fix.names.join(', ')} (verification.passEnv)`;
    case 'start_service':
      return `start the "${fix.service}" service the tests connect to on port ${fix.port} (${fix.command})`;
    case 'manual':
      return fix.note;
  }
}

export function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

export interface AppliedFixes {
  /** What was done, in words. */
  applied: string[];
  /** What was tried and did not work, with the reason. */
  failed: string[];
  /** For callers holding a loaded config in memory. */
  linksAdded: string[];
  envAdded: string[];
}

/** Applies the actionable fixes: edits `.taskforge/config.yaml` and starts services. */
export async function applyEnvironmentFixes(repoRoot: string, fixes: EnvironmentFix[]): Promise<AppliedFixes> {
  const result: AppliedFixes = { applied: [], failed: [], linksAdded: [], envAdded: [] };
  for (const fix of actionableFixes(fixes)) {
    try {
      if (fix.kind === 'link_files') {
        const defaults = getDefaultConfig().execution.worktreeLinks;
        const { added } = addToProjectConfigList(repoRoot, ['execution', 'worktreeLinks'], fix.paths, defaults);
        result.linksAdded.push(...fix.paths);
        result.applied.push(
          added.length > 0
            ? `Added ${added.join(', ')} to execution.worktreeLinks in .taskforge/config.yaml`
            : `${fix.paths.join(', ')} was already linked`,
        );
      } else if (fix.kind === 'pass_env') {
        const { added } = addToProjectConfigList(repoRoot, ['verification', 'passEnv'], fix.names, []);
        result.envAdded.push(...fix.names);
        result.applied.push(
          added.length > 0
            ? `Added ${added.join(', ')} to verification.passEnv in .taskforge/config.yaml`
            : `${fix.names.join(', ')} was already allowed`,
        );
      } else if (fix.kind === 'start_service') {
        const run = await ProcessRunner.run({
          command: 'docker',
          args: ['compose', '-f', fix.file, 'up', '-d', fix.service],
          cwd: repoRoot,
          timeoutMs: 180_000,
        });
        if (run.exitCode !== 0) {
          result.failed.push(`Could not start "${fix.service}": ${(run.stderr || run.stdout).trim().split('\n').pop() ?? 'docker compose failed'}`);
          continue;
        }
        const up = await waitForPort(fix.port, 30_000);
        if (up) result.applied.push(`Started "${fix.service}" and port ${fix.port} is accepting connections`);
        else result.failed.push(`Started "${fix.service}" but port ${fix.port} did not accept connections within 30s`);
      }
    } catch (err) {
      result.failed.push(`${describeFix(fix)}: ${(err as Error).message}`);
    }
  }
  return result;
}
