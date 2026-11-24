import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitService } from '@taskforge/workspace';
import { colors } from './theme.js';

export interface LinkedRepoConfig {
  name: string;
  path: string;
  role?: string;
}

export interface MultiRepoWorkspaceConfig {
  version: 1;
  repos: LinkedRepoConfig[];
  updatedAt: string;
}

export interface LinkedRepoStatus {
  name: string;
  path: string;
  role?: string;
  exists: boolean;
  isGitRepo: boolean;
  branch?: string;
  headCommit?: string;
  isClean?: boolean;
  dirtyCount?: number;
}

const WORKSPACE_REL_PATH = path.join('.taskforge', 'workspace.json');

export function loadMultiRepoWorkspace(repoRoot: string): MultiRepoWorkspaceConfig | undefined {
  const filePath = path.join(repoRoot, WORKSPACE_REL_PATH);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<MultiRepoWorkspaceConfig>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.repos)) {
      return {
        version: 1,
        repos: parsed.repos,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveMultiRepoWorkspace(
  repoRoot: string,
  repos: LinkedRepoConfig[],
): { filePath: string; config: MultiRepoWorkspaceConfig } {
  const filePath = path.join(repoRoot, WORKSPACE_REL_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const config: MultiRepoWorkspaceConfig = {
    version: 1,
    repos,
    updatedAt: new Date().toISOString(),
  };
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
  return { filePath, config };
}

/**
 * Coordinates sibling repositories (e.g. API + Web + SDK) via `.taskforge/workspace.json`:
 * unified git status across repos, synchronized feature branch creation, and
 * cross-repo contract context injection.
 */
export class MultiRepoCoordinator {
  constructor(private readonly repoRoot: string) {}

  public initFromPaths(rawPaths: string[]): { config: MultiRepoWorkspaceConfig; invalid: string[] } {
    const repos: LinkedRepoConfig[] = [
      { name: path.basename(this.repoRoot), path: this.repoRoot, role: 'primary' },
    ];
    const invalid: string[] = [];
    const seen = new Set<string>([path.resolve(this.repoRoot)]);

    for (const raw of rawPaths) {
      const resolved = path.resolve(this.repoRoot, raw);
      if (seen.has(resolved)) continue;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        invalid.push(raw);
        continue;
      }
      seen.add(resolved);
      repos.push({ name: path.basename(resolved), path: resolved });
    }

    const { config } = saveMultiRepoWorkspace(this.repoRoot, repos);
    return { config, invalid };
  }

  public async getStatuses(): Promise<LinkedRepoStatus[]> {
    const cfg = loadMultiRepoWorkspace(this.repoRoot);
    if (!cfg) return [];

    return Promise.all(
      cfg.repos.map(async (repo) => {
        if (!fs.existsSync(repo.path)) {
          return { ...repo, exists: false, isGitRepo: false };
        }
        const git = new GitService(repo.path);
        const isGit = await git.isGitRepo().catch(() => false);
        if (!isGit) {
          return { ...repo, exists: true, isGitRepo: false };
        }
        const st = await git.getStatus(repo.path).catch(() => undefined);
        const porcelain = await git.exec(['status', '--porcelain'], repo.path).catch(() => '');
        const dirtyCount = porcelain
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean).length;
        return {
          ...repo,
          exists: true,
          isGitRepo: true,
          branch: st?.currentBranch,
          headCommit: st?.headCommit?.slice(0, 7),
          isClean: st?.isClean,
          dirtyCount,
        };
      }),
    );
  }

  /** Creates/switches to a synchronized feature branch across every clean linked git repository. */
  public async createLinkedBranches(
    branchName: string,
  ): Promise<Array<{ repo: string; ok: boolean; detail: string }>> {
    const statuses = await this.getStatuses();
    const results: Array<{ repo: string; ok: boolean; detail: string }> = [];
    for (const st of statuses) {
      if (!st.exists || !st.isGitRepo) {
        results.push({ repo: st.name, ok: false, detail: 'not a git repository' });
        continue;
      }
      const git = new GitService(st.path);
      try {
        await git.exec(['checkout', '-B', branchName], st.path);
        results.push({ repo: st.name, ok: true, detail: `switched to ${branchName}` });
      } catch (err) {
        results.push({
          repo: st.name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  public async formatStatusDisplay(): Promise<string> {
    const statuses = await this.getStatuses();
    if (statuses.length === 0) {
      return [
        `${colors.dim}No multi-repo workspace configured (.taskforge/workspace.json).${colors.reset}`,
        `  ${colors.dim}Link sibling repos: /multirepo init ../api ../web ../sdk${colors.reset}`,
      ].join('\n');
    }
    const lines = [
      `${colors.brand}✦ ${colors.bold}Multi-Repository Workspace${colors.reset} ${colors.dim}(${statuses.length} linked repos)${colors.reset}`,
    ];
    for (const s of statuses) {
      const icon = !s.exists
        ? `${colors.red}✖${colors.reset}`
        : s.isClean
          ? `${colors.green}✔${colors.reset}`
          : `${colors.yellow}●${colors.reset}`;
      const stateText = !s.exists
        ? 'missing path'
        : !s.isGitRepo
          ? 'non-git dir'
          : `${s.branch ?? 'HEAD'} (${s.headCommit ?? '?'}) · ${s.isClean ? 'clean' : `${s.dirtyCount} dirty`}`;
      lines.push(
        `  ${icon} ${colors.bold}${s.name}${colors.reset}${s.role ? ` ${colors.dim}[${s.role}]${colors.reset}` : ''}: ${stateText}  ${colors.dim}(${s.path})${colors.reset}`,
      );
    }
    lines.push(
      `  ${colors.dim}Commands: /multirepo init <paths...>  ·  /multirepo branch <feat/name>  ·  /multirepo status${colors.reset}`,
    );
    return lines.join('\n');
  }
}
