import * as fs from 'node:fs';
import * as path from 'node:path';
import { RepositoryProfile } from '@taskforge/shared';
import { GitService } from './git-service.js';

export class RepositoryAnalyzer {
  constructor(
    private repoRoot: string,
    private gitService?: GitService,
  ) {
    if (!this.gitService) {
      this.gitService = new GitService(repoRoot);
    }
  }

  async analyze(): Promise<RepositoryProfile> {
    const languages: Set<string> = new Set();
    const frameworks: Set<string> = new Set();
    let packageManager: string | undefined;
    const testCommands: string[] = [];
    const lintCommands: string[] = [];
    const typecheckCommands: string[] = [];
    const buildCommands: string[] = [];

    // Package manager detection
    if (fs.existsSync(path.join(this.repoRoot, 'pnpm-lock.yaml'))) {
      packageManager = 'pnpm';
    } else if (fs.existsSync(path.join(this.repoRoot, 'yarn.lock'))) {
      packageManager = 'yarn';
    } else if (fs.existsSync(path.join(this.repoRoot, 'package-lock.json'))) {
      packageManager = 'npm';
    } else if (fs.existsSync(path.join(this.repoRoot, 'bun.lockb'))) {
      packageManager = 'bun';
    } else if (fs.existsSync(path.join(this.repoRoot, 'Cargo.lock'))) {
      packageManager = 'cargo';
    }

    // Node / JS / TS inspection
    const pkgJsonPath = path.join(this.repoRoot, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        languages.add('JavaScript');
        if (
          fs.existsSync(path.join(this.repoRoot, 'tsconfig.json')) ||
          pkg.devDependencies?.typescript ||
          pkg.dependencies?.typescript
        ) {
          languages.add('TypeScript');
        }

        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react) frameworks.add('React');
        if (deps.vue) frameworks.add('Vue');
        if (deps.next) frameworks.add('Next.js');
        if (deps.express) frameworks.add('Express');
        if (deps.vitest || deps.jest) frameworks.add('Vitest/Jest');

        const pm = packageManager ?? 'npm';
        if (pkg.scripts) {
          if (pkg.scripts.test) testCommands.push(`${pm} test`);
          if (pkg.scripts.lint) lintCommands.push(`${pm} run lint`);
          if (pkg.scripts.typecheck) typecheckCommands.push(`${pm} run typecheck`);
          if (pkg.scripts.build) buildCommands.push(`${pm} run build`);
        }
      } catch {
        // invalid package.json
      }
    }

    // Python inspection
    if (
      fs.existsSync(path.join(this.repoRoot, 'pyproject.toml')) ||
      fs.existsSync(path.join(this.repoRoot, 'requirements.txt'))
    ) {
      languages.add('Python');
      testCommands.push('pytest');
      lintCommands.push('ruff check');
      typecheckCommands.push('mypy .');
    }

    // Rust inspection
    if (fs.existsSync(path.join(this.repoRoot, 'Cargo.toml'))) {
      languages.add('Rust');
      testCommands.push('cargo test');
      lintCommands.push('cargo clippy');
      typecheckCommands.push('cargo check');
      buildCommands.push('cargo build');
    }

    // Go inspection
    if (fs.existsSync(path.join(this.repoRoot, 'go.mod'))) {
      languages.add('Go');
      testCommands.push('go test ./...');
      lintCommands.push('golangci-lint run');
      buildCommands.push('go build ./...');
    }

    // ECC detection (Spec Section 21.1)
    const hasECC =
      fs.existsSync(path.join(this.repoRoot, '.ecc')) ||
      fs.existsSync(path.join(this.repoRoot, 'ecc.yaml')) ||
      fs.existsSync(path.join(this.repoRoot, '.ecc-rules'));

    const summary = `Repository at ${this.repoRoot}: ${Array.from(languages).join(', ') || 'unknown language'}${packageManager ? ` using ${packageManager}` : ''}${hasECC ? ' (ECC detected)' : ''}`;

    return {
      languages: Array.from(languages),
      frameworks: Array.from(frameworks),
      packageManager,
      testCommands,
      lintCommands,
      typecheckCommands,
      buildCommands,
      hasECC,
      summary,
    };
  }
}
