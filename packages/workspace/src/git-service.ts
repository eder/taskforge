import { ProcessRunner } from '@taskforge/execution';
import { RepositoryError } from '@taskforge/shared';

export interface GitStatus {
  isClean: boolean;
  currentBranch: string;
  headCommit: string;
  uncommittedFiles: string[];
}

export class GitService {
  constructor(private repoRoot: string) {}

  async exec(args: string[], cwd: string = this.repoRoot): Promise<string> {
    const result = await ProcessRunner.run({
      command: 'git',
      args,
      cwd,
      timeoutMs: 30000,
    });

    if (result.exitCode !== 0) {
      throw new RepositoryError(`Git command failed: git ${args.join(' ')}\n${result.stderr}`, {
        args,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    return result.stdout.trim();
  }

  async execGit(args: string[], cwd: string = this.repoRoot): Promise<string> {
    return this.exec(args, cwd);
  }

  async isGitRepo(): Promise<boolean> {
    try {
      const out = await this.exec(['rev-parse', '--is-inside-work-tree']);
      return out === 'true';
    } catch {
      return false;
    }
  }

  async getStatus(cwd: string = this.repoRoot): Promise<GitStatus> {
    const porcelain = await this.exec(['status', '--porcelain'], cwd);
    const uncommittedFiles = porcelain
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const isClean = uncommittedFiles.length === 0;

    let currentBranch = 'HEAD';
    try {
      currentBranch = await this.exec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    } catch {
      // Might be detached head
    }

    let headCommit = '';
    try {
      headCommit = await this.exec(['rev-parse', 'HEAD'], cwd);
    } catch {
      headCommit = 'EMPTY_TREE';
    }

    return {
      isClean,
      currentBranch,
      headCommit,
      uncommittedFiles,
    };
  }

  async getHeadCommit(cwd: string = this.repoRoot): Promise<string> {
    try {
      return await this.exec(['rev-parse', 'HEAD'], cwd);
    } catch {
      return await this.ensureInitialCommit(cwd);
    }
  }

  async ensureInitialCommit(cwd: string = this.repoRoot): Promise<string> {
    try {
      return await this.exec(['rev-parse', 'HEAD'], cwd);
    } catch {
      const isRepo = await this.isGitRepo();
      if (!isRepo) {
        await this.exec(['init', '-b', 'main'], cwd);
      }

      let hasUser = false;
      try {
        const userName = await this.exec(['config', 'user.name'], cwd);
        if (userName.trim()) hasUser = true;
      } catch {
        hasUser = false;
      }

      if (!hasUser) {
        await this.exec(['config', 'user.name', 'TaskForge Bot'], cwd);
        await this.exec(['config', 'user.email', 'bot@taskforge.dev'], cwd);
      }

      const statusOutput = await this.exec(['status', '--porcelain'], cwd).catch(() => '');
      if (statusOutput.trim().length > 0) {
        await this.exec(['add', '-A'], cwd);
        await this.exec(['commit', '-m', 'chore: initial commit by TaskForge'], cwd);
      } else {
        await this.exec(
          ['commit', '--allow-empty', '-m', 'chore: initial commit by TaskForge'],
          cwd,
        );
      }

      return await this.exec(['rev-parse', 'HEAD'], cwd);
    }
  }

  async createBranch(branchName: string, startPoint?: string): Promise<void> {
    const args = ['branch', branchName];
    if (startPoint) {
      args.push(startPoint);
    }
    await this.exec(args);
  }

  async deleteBranch(branchName: string, force: boolean = false): Promise<void> {
    await this.exec(['branch', force ? '-D' : '-d', branchName]);
  }

  async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.exec(['rev-parse', '--verify', branchName]);
      return true;
    } catch {
      return false;
    }
  }

  async stageAndCommit(message: string, cwd: string): Promise<string> {
    await this.exec(['add', '-A'], cwd);
    const status = await this.getStatus(cwd);
    if (status.isClean) {
      // Nothing to commit, return current HEAD
      return this.getHeadCommit(cwd);
    }
    await this.exec(['commit', '-m', message], cwd);
    return this.getHeadCommit(cwd);
  }

  async cherryPick(commitHash: string, cwd: string = this.repoRoot): Promise<string> {
    await this.exec(['cherry-pick', commitHash], cwd);
    return this.getHeadCommit(cwd);
  }

  async abortCherryPick(cwd: string = this.repoRoot): Promise<void> {
    await this.exec(['cherry-pick', '--abort'], cwd);
  }

  async checkout(ref: string, cwd: string = this.repoRoot): Promise<void> {
    await this.exec(['checkout', ref], cwd);
  }
}
