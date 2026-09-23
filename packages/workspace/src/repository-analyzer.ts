import * as fs from 'node:fs';
import * as path from 'node:path';
import { RepositoryProfile } from '@taskforge/shared';
import { GitService } from './git-service.js';
import { ProjectInstructionResolver } from './project-instructions.js';

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

    // Polyglot/subproject inspection. Root-only detection is insufficient for
    // repositories that keep Python, Node, iOS, or other build systems in
    // dedicated directories.
    const topLevelEntries = fs.readdirSync(this.repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules');
    for (const entry of topLevelEntries) {
      const subdir = path.join(this.repoRoot, entry.name);
      const subPkgPath = path.join(subdir, 'package.json');
      if (fs.existsSync(subPkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(subPkgPath, 'utf8'));
          languages.add('JavaScript');
          if (fs.existsSync(path.join(subdir, 'tsconfig.json')) || pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
            languages.add('TypeScript');
          }
          const pm = fs.existsSync(path.join(subdir, 'pnpm-lock.yaml')) ? 'pnpm'
            : fs.existsSync(path.join(subdir, 'yarn.lock')) ? 'yarn'
            : fs.existsSync(path.join(subdir, 'bun.lockb')) ? 'bun'
            : 'npm';
          if (pkg.scripts?.test) testCommands.push(`cd ${entry.name} && ${pm} test`);
          if (pkg.scripts?.lint) lintCommands.push(`cd ${entry.name} && ${pm} run lint`);
          if (pkg.scripts?.typecheck) typecheckCommands.push(`cd ${entry.name} && ${pm} run typecheck`);
          if (pkg.scripts?.build) buildCommands.push(`cd ${entry.name} && ${pm} run build`);
        } catch {
          // invalid subproject package.json
        }
      }

      if (fs.existsSync(path.join(subdir, 'pyproject.toml')) || fs.existsSync(path.join(subdir, 'requirements.txt'))) {
        languages.add('Python');
        testCommands.push(`python -m pytest ${entry.name}`);
      }

      if (entry.name === 'ios' && fs.readdirSync(subdir).some((name) => name.endsWith('.xcodeproj'))) {
        languages.add('Swift');
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

    const instructions = new ProjectInstructionResolver(this.repoRoot).resolve(['*']);

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
      projectInstructions: instructions.documents,
      instructionWarnings: instructions.warnings,
    };
  }
}
