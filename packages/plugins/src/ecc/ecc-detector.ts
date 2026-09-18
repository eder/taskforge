import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ECCDetectionResult {
  detected: boolean;
  eccPath?: string;
  source: 'repo' | 'home' | 'env' | 'none';
  availableSkills: string[];
  availableRules: string[];
}

export class ECCDetector {
  static detect(repoRoot: string): ECCDetectionResult {
    // 1. Check environment variable
    if (process.env.ECC_PATH && fs.existsSync(process.env.ECC_PATH)) {
      return this.inspectDirectory(process.env.ECC_PATH, 'env');
    }

    // 2. Check repo root .ecc
    const repoEcc = path.join(repoRoot, '.ecc');
    if (fs.existsSync(repoEcc)) {
      return this.inspectDirectory(repoEcc, 'repo');
    }

    // 3. Check user home ~/.ecc
    const homeEcc = path.join(os.homedir(), '.ecc');
    if (fs.existsSync(homeEcc)) {
      return this.inspectDirectory(homeEcc, 'home');
    }

    return {
      detected: false,
      source: 'none',
      availableSkills: [],
      availableRules: [],
    };
  }

  private static inspectDirectory(
    dirPath: string,
    source: 'repo' | 'home' | 'env',
  ): ECCDetectionResult {
    const availableSkills: string[] = [];
    const availableRules: string[] = [];

    const skillsDir = path.join(dirPath, 'skills');
    if (fs.existsSync(skillsDir)) {
      try {
        const files = fs.readdirSync(skillsDir);
        availableSkills.push(
          ...files.map((f) => f.replace(/\.(md|json|ya?ml)$/, '').toLowerCase()),
        );
      } catch {
        // ignore read error
      }
    }

    const rulesDir = path.join(dirPath, 'rules');
    if (fs.existsSync(rulesDir)) {
      try {
        const files = fs.readdirSync(rulesDir);
        availableRules.push(
          ...files.map((f) => f.replace(/\.(md|json|ya?ml)$/, '').toLowerCase()),
        );
      } catch {
        // ignore read error
      }
    }

    // If no subdirs, check root files
    if (availableSkills.length === 0 && availableRules.length === 0) {
      try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          if (file.includes('rule')) availableRules.push(file);
          else if (file.includes('skill')) availableSkills.push(file);
        }
      } catch {
        // ignore
      }
    }

    // Default ECC standard capabilities if minimal directory exists
    if (availableSkills.length === 0) {
      availableSkills.push('auth/security', 'backend-patterns', 'tdd', 'code-review', 'frontend-patterns', 'kubernetes', 'ml');
    }

    return {
      detected: true,
      eccPath: dirPath,
      source,
      availableSkills,
      availableRules,
    };
  }
}
