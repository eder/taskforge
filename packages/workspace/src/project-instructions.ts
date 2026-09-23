import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectInstructionDocument {
  path: string;
  content: string;
  scope: string;
  kind: 'agent' | 'provider' | 'referenced';
}

export interface ProjectInstructionSet {
  documents: ProjectInstructionDocument[];
  warnings: string[];
}

const PRIMARY_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

export class ProjectInstructionResolver {
  constructor(private repoRoot: string) {}

  resolve(allowedScope: string[] = ['*']): ProjectInstructionSet {
    const documents = new Map<string, ProjectInstructionDocument>();
    const warnings: string[] = [];
    let totalBytes = 0;

    const add = (relativePath: string, kind: ProjectInstructionDocument['kind']): void => {
      const normalized = this.safeRelativePath(relativePath);
      if (!normalized || documents.has(normalized)) return;
      const absolute = path.join(this.repoRoot, normalized);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return;
      const size = fs.statSync(absolute).size;
      if (size > MAX_FILE_BYTES || totalBytes + size > MAX_TOTAL_BYTES) {
        warnings.push(`Skipped oversized project instruction: ${normalized}`);
        return;
      }
      const content = fs.readFileSync(absolute, 'utf8');
      totalBytes += Buffer.byteLength(content);
      const scope = path.dirname(normalized) === '.' ? '*' : `${path.dirname(normalized)}/**`;
      documents.set(normalized, { path: normalized, content, scope, kind });
    };

    for (const file of PRIMARY_FILES) add(file, file === 'AGENTS.md' ? 'agent' : 'provider');

    for (const scope of allowedScope) {
      const directory = this.scopeDirectory(scope);
      if (!directory) continue;
      let current = directory;
      while (current && current !== '.') {
        if (this.scopeIntersectsDirectory(allowedScope, current)) {
          for (const file of PRIMARY_FILES) {
            add(path.join(current, file), file === 'AGENTS.md' ? 'agent' : 'provider');
          }
        }
        const parent = path.dirname(current);
        if (parent === current || parent === '.') break;
        current = parent;
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const doc of [...documents.values()]) {
        for (const reference of this.markdownReferences(doc.content, path.dirname(doc.path))) {
          const before = documents.size;
          add(reference, 'referenced');
          if (documents.size > before) changed = true;
        }
      }
    }

    return { documents: [...documents.values()], warnings };
  }

  formatForAgent(set: ProjectInstructionSet): string {
    if (set.documents.length === 0) return '';
    const body = set.documents
      .map((doc) => `## ${doc.path} (scope: ${doc.scope})\n${doc.content.trim()}`)
      .join('\n\n');
    return [
      'PROJECT INSTRUCTIONS — authoritative repository guidance.',
      'Follow every applicable instruction below. More-specific path instructions refine root instructions.',
      'Do not invent a project rule when the documents are silent; ask or report the ambiguity instead.',
      body,
    ].join('\n\n');
  }

  private markdownReferences(content: string, baseDir: string): string[] {
    const refs = new Set<string>();
    const patterns = [
      /\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/gi,
      /(?:^|[\s`'"])((?:\.\.?\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+\.md)(?=$|[\s`'",):])/gim,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const raw = match[1].split('#')[0];
        if (/^[a-z]+:\/\//i.test(raw)) continue;
        const resolved = raw.startsWith('/')
          ? raw.slice(1)
          : path.normalize(path.join(baseDir === '.' ? '' : baseDir, raw));
        const safe = this.safeRelativePath(resolved);
        if (safe) refs.add(safe);
      }
    }
    return [...refs];
  }

  private safeRelativePath(candidate: string): string | undefined {
    const normalized = path.normalize(candidate).replace(/^\.\//, '');
    if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('..')) return undefined;
    const absolute = path.resolve(this.repoRoot, normalized);
    const root = path.resolve(this.repoRoot) + path.sep;
    if (absolute !== path.resolve(this.repoRoot) && !absolute.startsWith(root)) return undefined;
    return normalized;
  }

  private scopeDirectory(scope: string): string | undefined {
    if (!scope || scope === '*') return undefined;
    const clean = scope.replace(/\\/g, '/').replace(/[*?\[\]{}].*$/, '').replace(/\/$/, '');
    if (!clean) return undefined;
    return path.extname(clean) ? path.dirname(clean) : clean;
  }

  private scopeIntersectsDirectory(scopes: string[], directory: string): boolean {
    if (scopes.includes('*')) return true;
    const prefix = directory.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    return scopes.some((scope) => {
      const normalized = scope.replace(/\\/g, '/').replace(/^\.\//, '');
      return normalized === directory || normalized.startsWith(prefix) || prefix.startsWith(normalized.replace(/[*?].*$/, ''));
    });
  }
}
