import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { RepositoryIndexContext, RepositoryIndexHit } from '@taskforge/shared';

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONTENT_CHARS = 32_000;
const MAX_SYMBOLS_PER_FILE = 40;
const DEFAULT_INDEX_FILENAME = '.taskforge/repo-index.db';

const IGNORED_DIRS = new Set([
  '.git',
  '.taskforge',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

const SKIPPED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.wasm',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.lock',
  '.lockb',
  '.map',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.mov',
  '.wav',
  '.pcm',
  '.bin',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
]);

const SKIPPED_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
]);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'should',
  'that',
  'the',
  'their',
  'this',
  'to',
  'use',
  'using',
  'we',
  'when',
  'where',
  'with',
  'without',
  'add',
  'fix',
  'update',
  'make',
  'change',
  'implement',
  'create',
  'build',
  'com',
  'como',
  'das',
  'dos',
  'em',
  'na',
  'no',
  'para',
  'por',
  'que',
  'sem',
  'uma',
  'um',
]);

export interface RepositoryIndexStats {
  totalFiles: number;
  indexedFiles: number;
  updatedFiles: number;
  removedFiles: number;
  skippedFiles: number;
  edgeCount: number;
  testFiles: number;
  durationMs: number;
}

export interface RepositoryIndexerOptions {
  /** Custom SQLite database path, or `:memory:` for ephemeral indexing. */
  databasePath?: string;
}

export interface RepositorySearchOptions {
  limit?: number;
  includeTests?: boolean;
}

export function isTestFilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return (
    /(^|\/)(tests?|__tests__)\//.test(normalized) ||
    /\.(test|spec)\.[^/]+$/i.test(normalized) ||
    /(^|\/)test_[^/]+\.py$/i.test(normalized) ||
    /_test\.go$/i.test(normalized)
  );
}

/** Splits CamelCase, snake_case, kebab-case, and paths into searchable FTS tokens. */
export function expandSearchTokens(text: string): string {
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[/_.-]+/g, ' ');
  return `${text} ${expanded}`;
}

export function extractQueryTerms(query: string): string[] {
  const expanded = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const raw = expanded.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of raw) {
    if (token.length < 2 || STOP_WORDS.has(token) || /^\d+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
    if (terms.length >= 16) break;
  }
  return terms;
}

export function extractSymbols(content: string, ext: string): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const add = (name?: string) => {
    if (!name || name.length < 2 || seen.has(name)) return;
    seen.add(name);
    symbols.push(name);
  };

  const patterns: RegExp[] = [];
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    patterns.push(
      /^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
      /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
      /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
      /^(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
    );
  } else if (ext === '.py') {
    patterns.push(
      /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
      /^class\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    );
  } else if (ext === '.go') {
    patterns.push(
      /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/gm,
      /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/gm,
    );
  } else if (ext === '.rs') {
    patterns.push(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    );
  } else if (ext === '.swift' || ext === '.java' || ext === '.kt') {
    patterns.push(
      /^\s*(?:public|internal|private|open|final|abstract|static|\s)*\b(?:class|struct|enum|interface|protocol|func|fun)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    );
  }

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      add(match[1]);
      if (symbols.length >= MAX_SYMBOLS_PER_FILE) return symbols;
    }
  }
  return symbols;
}

export function extractRawImports(content: string, ext: string): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();
  const add = (spec?: string) => {
    const trimmed = spec?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    imports.push(trimmed);
  };

  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const jsImportRe =
      /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = jsImportRe.exec(content)) !== null) {
      add(m[1] ?? m[2] ?? m[3]);
    }
  } else if (ext === '.py') {
    const pyFromRe = /^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\b/gm;
    let m: RegExpExecArray | null;
    while ((m = pyFromRe.exec(content)) !== null) {
      add(m[1]);
    }
    const pyImpRe = /^\s*import\s+([A-Za-z0-9_.,\s]+)/gm;
    while ((m = pyImpRe.exec(content)) !== null) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0]?.trim();
        add(mod);
      }
    }
  }
  return imports;
}

function resolveImportTarget(
  fromRelPath: string,
  specifier: string,
  ext: string,
  trackedSet: Set<string>,
): string | undefined {
  const fromDir = path.posix.dirname(fromRelPath);

  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    if (!specifier.startsWith('.')) return undefined;
    const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
    const candidates: string[] = [joined];
    const withoutJs = joined.replace(/\.(?:m|c)?jsx?$/, '');
    const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    for (const candidateExt of exts) {
      candidates.push(`${withoutJs}${candidateExt}`);
      candidates.push(`${joined}${candidateExt}`);
    }
    for (const candidateExt of exts) {
      candidates.push(path.posix.join(joined, `index${candidateExt}`));
    }
    for (const candidate of candidates) {
      if (trackedSet.has(candidate)) return candidate;
    }
    return undefined;
  }

  if (ext === '.py') {
    const leadingDots = specifier.match(/^(\.+)(.*)$/);
    if (leadingDots) {
      const levels = leadingDots[1].length - 1;
      const rest = leadingDots[2].replace(/\./g, '/');
      let baseDir = fromDir;
      for (let i = 0; i < levels; i++) {
        baseDir = path.posix.dirname(baseDir);
      }
      const joined = rest ? path.posix.normalize(path.posix.join(baseDir, rest)) : baseDir;
      for (const candidate of [`${joined}.py`, path.posix.join(joined, '__init__.py')]) {
        if (trackedSet.has(candidate)) return candidate;
      }
      return undefined;
    }
    const asPath = specifier.replace(/\./g, '/');
    for (const candidate of [`${asPath}.py`, path.posix.join(asPath, '__init__.py')]) {
      if (trackedSet.has(candidate)) return candidate;
    }
  }

  return undefined;
}

function fileStem(relPath: string): string {
  const base = path.posix.basename(relPath);
  return base
    .replace(/\.(test|spec)\.[^.]+$/i, '')
    .replace(/^test_/i, '')
    .replace(/_test\.go$/i, '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
}

function scopeGlobForPath(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length <= 1) return relPath;
  if ((parts[0] === 'packages' || parts[0] === 'apps') && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}/**`;
  }
  if (parts[0] === 'src' && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}/**`;
  }
  return `${parts.slice(0, -1).join('/')}/**`;
}

function shouldIndexFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((p) => IGNORED_DIRS.has(p))) return false;
  const baseLower = path.posix.basename(normalized).toLowerCase();
  if (SKIPPED_BASENAMES.has(baseLower)) return false;
  if (baseLower.endsWith('.min.js') || baseLower.endsWith('.min.css')) return false;
  const ext = path.posix.extname(baseLower);
  if (SKIPPED_EXTENSIONS.has(ext)) return false;
  return true;
}

function listCandidateFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && shouldIndexFile(line));
  } catch {
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, rel);
        } else if (entry.isFile() && shouldIndexFile(rel)) {
          files.push(rel);
        }
      }
    };
    walk(repoRoot, '');
    return files;
  }
}

/**
 * Local offline BM25 + import-graph repository indexer backed by Node's
 * built-in SQLite FTS5 engine. Provides zero-cloud, token-free architectural
 * context (relevant files, symbols, import edges, and related tests) to the
 * planner, router, and CLI (`tf index`).
 */
export class RepositoryIndexer {
  private db: SqliteDatabase;
  private readonly repoRoot: string;

  constructor(repoRoot: string, options: RepositoryIndexerOptions = {}) {
    this.repoRoot = path.resolve(repoRoot);
    const dbPath =
      options.databasePath ??
      (fs.existsSync(path.join(this.repoRoot, '.git'))
        ? path.join(this.repoRoot, DEFAULT_INDEX_FILENAME)
        : ':memory:');

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS indexed_files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        ext TEXT NOT NULL,
        is_test INTEGER NOT NULL DEFAULT 0,
        symbols_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS file_edges (
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL,
        specifier TEXT NOT NULL,
        PRIMARY KEY (from_path, to_path)
      );

      CREATE INDEX IF NOT EXISTS idx_file_edges_to ON file_edges(to_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
        file_path UNINDEXED,
        path_tokens,
        symbols,
        content,
        tokenize = "unicode61 tokenchars '_'"
      );
    `);
  }

  /** Incrementally indexes tracked source files, skipping unchanged files. */
  index(): RepositoryIndexStats {
    const started = Date.now();
    const candidates = listCandidateFiles(this.repoRoot);
    const trackedSet = new Set(candidates);

    const existingRows = this.db
      .prepare('SELECT path, mtime_ms, size_bytes FROM indexed_files')
      .all() as Array<{ path: string; mtime_ms: number; size_bytes: number }>;
    const existing = new Map(existingRows.map((r) => [r.path, r]));

    let updatedFiles = 0;
    let removedFiles = 0;
    let skippedFiles = 0;

    const deleteFileStmt = this.db.prepare('DELETE FROM indexed_files WHERE path = ?');
    const deleteFtsStmt = this.db.prepare('DELETE FROM file_fts WHERE file_path = ?');
    const deleteEdgesStmt = this.db.prepare('DELETE FROM file_edges WHERE from_path = ?');
    const upsertFileStmt = this.db.prepare(
      `INSERT INTO indexed_files (path, mtime_ms, size_bytes, ext, is_test, symbols_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms = excluded.mtime_ms,
         size_bytes = excluded.size_bytes,
         ext = excluded.ext,
         is_test = excluded.is_test,
         symbols_json = excluded.symbols_json`,
    );
    const insertFtsStmt = this.db.prepare(
      'INSERT INTO file_fts (file_path, path_tokens, symbols, content) VALUES (?, ?, ?, ?)',
    );
    const insertEdgeStmt = this.db.prepare(
      'INSERT OR IGNORE INTO file_edges (from_path, to_path, specifier) VALUES (?, ?, ?)',
    );

    this.db.exec('BEGIN');
    try {
      for (const oldPath of existing.keys()) {
        if (!trackedSet.has(oldPath)) {
          deleteFileStmt.run(oldPath);
          deleteFtsStmt.run(oldPath);
          deleteEdgesStmt.run(oldPath);
          removedFiles += 1;
        }
      }

      for (const relPath of candidates) {
        const fullPath = path.join(this.repoRoot, relPath);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          skippedFiles += 1;
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          skippedFiles += 1;
          continue;
        }

        const mtimeMs = Math.floor(stat.mtimeMs);
        const prev = existing.get(relPath);
        if (prev && prev.mtime_ms === mtimeMs && prev.size_bytes === stat.size) {
          continue;
        }

        let raw: Buffer;
        try {
          raw = fs.readFileSync(fullPath);
        } catch {
          skippedFiles += 1;
          continue;
        }
        // Skip binary files containing null bytes.
        if (raw.includes(0)) {
          skippedFiles += 1;
          continue;
        }

        const content = raw.toString('utf8');
        const ext = path.posix.extname(relPath).toLowerCase();
        const isTest = isTestFilePath(relPath) ? 1 : 0;
        const symbols = extractSymbols(content, ext);
        const rawImports = extractRawImports(content, ext);

        upsertFileStmt.run(
          relPath,
          mtimeMs,
          stat.size,
          ext,
          isTest,
          JSON.stringify(symbols),
        );

        deleteFtsStmt.run(relPath);
        insertFtsStmt.run(
          relPath,
          expandSearchTokens(relPath),
          expandSearchTokens(symbols.join(' ')),
          expandSearchTokens(content.slice(0, MAX_CONTENT_CHARS)),
        );

        deleteEdgesStmt.run(relPath);
        for (const spec of rawImports) {
          const target = resolveImportTarget(relPath, spec, ext, trackedSet);
          if (target && target !== relPath) {
            insertEdgeStmt.run(relPath, target, spec);
          }
        }

        updatedFiles += 1;
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const counts = this.getCounts();
    return {
      totalFiles: candidates.length,
      indexedFiles: counts.indexedFiles,
      updatedFiles,
      removedFiles,
      skippedFiles,
      edgeCount: counts.edgeCount,
      testFiles: counts.testFiles,
      durationMs: Date.now() - started,
    };
  }

  getCounts(): { indexedFiles: number; edgeCount: number; testFiles: number } {
    const fileRow = this.db
      .prepare(
        'SELECT COUNT(*) AS total, COALESCE(SUM(is_test), 0) AS tests FROM indexed_files',
      )
      .get() as { total: number; tests: number } | undefined;
    const edgeRow = this.db
      .prepare('SELECT COUNT(*) AS edges FROM file_edges')
      .get() as { edges: number } | undefined;
    return {
      indexedFiles: Number(fileRow?.total ?? 0),
      testFiles: Number(fileRow?.tests ?? 0),
      edgeCount: Number(edgeRow?.edges ?? 0),
    };
  }

  getImports(relPath: string): string[] {
    const rows = this.db
      .prepare('SELECT to_path FROM file_edges WHERE from_path = ? ORDER BY to_path ASC')
      .all(relPath) as Array<{ to_path: string }>;
    return rows.map((r) => r.to_path);
  }

  getImportedBy(relPath: string): string[] {
    const rows = this.db
      .prepare('SELECT from_path FROM file_edges WHERE to_path = ? ORDER BY from_path ASC')
      .all(relPath) as Array<{ from_path: string }>;
    return rows.map((r) => r.from_path);
  }

  findRelatedTests(relPath: string): string[] {
    if (isTestFilePath(relPath)) return [];
    const related = new Set<string>();

    // 1. Test files that directly import this file.
    const importingTests = this.db
      .prepare(
        `SELECT e.from_path
         FROM file_edges e
         JOIN indexed_files f ON f.path = e.from_path
         WHERE e.to_path = ? AND f.is_test = 1
         ORDER BY e.from_path ASC`,
      )
      .all(relPath) as Array<{ from_path: string }>;
    for (const row of importingTests) related.add(row.from_path);

    // 2. Test files with matching basename stem (e.g. auth.ts -> auth.test.ts).
    const stem = fileStem(relPath);
    if (stem.length >= 3 && stem !== 'index') {
      const allTests = this.db
        .prepare('SELECT path FROM indexed_files WHERE is_test = 1 ORDER BY path ASC')
        .all() as Array<{ path: string }>;
      for (const row of allTests) {
        if (fileStem(row.path) === stem) {
          related.add(row.path);
        }
      }
    }

    return Array.from(related).slice(0, 6);
  }

  /** Ranks repository files matching `query` via SQLite FTS5 BM25. */
  search(query: string, options: RepositorySearchOptions = {}): RepositoryIndexHit[] {
    const limit = Math.max(1, Math.min(50, options.limit ?? 8));
    const includeTests = options.includeTests ?? true;
    const terms = extractQueryTerms(query);
    if (terms.length === 0) return [];

    // Quote every term so FTS5 operators (NOT, NEAR, AND) or punctuation cannot fail parsing.
    const matchExpr = terms.map((t) => `"${t}"`).join(' OR ');
    const sql = `
      SELECT
        f.path AS path,
        f.is_test AS is_test,
        f.symbols_json AS symbols_json,
        bm25(file_fts, 0.0, 4.0, 3.0, 1.0) AS rank
      FROM file_fts
      JOIN indexed_files f ON f.path = file_fts.file_path
      WHERE file_fts MATCH ?
      ${includeTests ? '' : 'AND f.is_test = 0'}
      ORDER BY rank ASC
      LIMIT ?
    `;

    let rows: Array<{ path: string; is_test: number; symbols_json: string; rank: number }>;
    try {
      rows = this.db.prepare(sql).all(matchExpr, limit) as Array<{
        path: string;
        is_test: number;
        symbols_json: string;
        rank: number;
      }>;
    } catch {
      return [];
    }

    return rows.map((row) => {
      let symbols: string[] = [];
      try {
        const parsed = JSON.parse(row.symbols_json);
        if (Array.isArray(parsed)) symbols = parsed.filter((s): s is string => typeof s === 'string');
      } catch {
        symbols = [];
      }
      return {
        path: row.path,
        // FTS5 bm25() returns negative scores (closer to -Infinity is better); expose positive relevance.
        score: Number(Math.abs(row.rank).toFixed(4)),
        isTest: row.is_test === 1,
        symbols: symbols.slice(0, 8),
        imports: this.getImports(row.path).slice(0, 8),
        importedBy: this.getImportedBy(row.path).slice(0, 8),
        relatedTests: this.findRelatedTests(row.path),
      };
    });
  }

  /**
   * Builds a compact, token-free architectural context block for a goal:
   * matched source files, symbols, import dependencies, related tests, and
   * non-overlapping directory scope globs.
   */
  buildContextForGoal(goal: string, options: { limit?: number } = {}): RepositoryIndexContext {
    const counts = this.getCounts();
    const matches = this.search(goal, { limit: options.limit ?? 8, includeTests: false });
    const relatedTestSet = new Set<string>();
    const scopeSet = new Set<string>();

    for (const hit of matches) {
      scopeSet.add(scopeGlobForPath(hit.path));
      for (const testPath of hit.relatedTests) {
        relatedTestSet.add(testPath);
      }
    }

    const summaryLines = matches.map((hit) => {
      const details: string[] = [];
      if (hit.symbols.length > 0) details.push(`symbols: ${hit.symbols.slice(0, 5).join(', ')}`);
      if (hit.imports.length > 0) details.push(`imports: ${hit.imports.slice(0, 4).join(', ')}`);
      if (hit.importedBy.length > 0) {
        details.push(`importedBy: ${hit.importedBy.slice(0, 3).join(', ')}`);
      }
      if (hit.relatedTests.length > 0) {
        details.push(`tests: ${hit.relatedTests.slice(0, 3).join(', ')}`);
      }
      return details.length > 0 ? `${hit.path} (${details.join('; ')})` : hit.path;
    });

    return {
      indexedFiles: counts.indexedFiles,
      matches,
      suggestedScopes: Array.from(scopeSet).slice(0, 6),
      relatedTests: Array.from(relatedTestSet).slice(0, 8),
      summaryLines,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** Convenience one-shot helper: incrementally updates index, queries goal context, and closes DB. */
  static queryGoal(
    repoRoot: string,
    goal: string,
    options: RepositoryIndexerOptions & { limit?: number } = {},
  ): RepositoryIndexContext {
    const indexer = new RepositoryIndexer(repoRoot, options);
    try {
      indexer.index();
      return indexer.buildContextForGoal(goal, { limit: options.limit });
    } finally {
      indexer.close();
    }
  }
}
