import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RepositoryIndexer,
  extractQueryTerms,
  extractSymbols,
  isTestFilePath,
} from '../src/repo-indexer.js';
import { RepositoryAnalyzer } from '../src/repository-analyzer.js';

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
}

function commitAll(dir: string, message = 'commit'): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

describe('RepositoryIndexer (offline SQLite FTS5 BM25 + import graph)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-repo-indexer-'));
    initGitRepo(tmpDir);

    fs.mkdirSync(path.join(tmpDir, 'src/auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/billing'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/http'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tests/auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'python'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, 'src/auth/jwt.ts'),
      `export interface JwtPayload { sub: string; exp: number; }
export function verifyJwtToken(token: string): JwtPayload {
  return { sub: token, exp: 0 };
}
export function signJwtToken(sub: string): string {
  return sub;
}
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'src/http/middleware.ts'),
      `import { verifyJwtToken } from '../auth/jwt.js';
export function requireAuthMiddleware(header: string) {
  return verifyJwtToken(header);
}
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'src/billing/invoice.ts'),
      `export class InvoiceCalculator {
  computeTotal(cents: number): number {
    return cents;
  }
}
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'tests/auth/jwt.test.ts'),
      `import { verifyJwtToken } from '../../src/auth/jwt.js';
export const ok = Boolean(verifyJwtToken);
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'python/retry_policy.py'),
      `class BackoffPolicy:
    def compute_delay(self, attempt: int) -> float:
        return attempt * 1.5
`,
    );

    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    fs.writeFileSync(path.join(tmpDir, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    commitAll(tmpDir, 'initial fixture');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes source files, extracts multi-language symbols, and skips lockfiles/binaries', () => {
    const indexer = new RepositoryIndexer(tmpDir, { databasePath: ':memory:' });
    try {
      const stats = indexer.index();
      expect(stats.indexedFiles).toBe(5);
      expect(stats.updatedFiles).toBe(5);
      expect(stats.testFiles).toBe(1);
      expect(stats.edgeCount).toBe(2); // middleware -> jwt, jwt.test -> jwt

      const jwtHits = indexer.search('verify jwt token');
      expect(jwtHits[0]?.path).toBe('src/auth/jwt.ts');
      expect(jwtHits[0]?.symbols).toContain('verifyJwtToken');
      expect(jwtHits[0]?.symbols).toContain('JwtPayload');

      const pyHits = indexer.search('backoff delay');
      expect(pyHits[0]?.path).toBe('python/retry_policy.py');
      expect(pyHits[0]?.symbols).toContain('BackoffPolicy');
    } finally {
      indexer.close();
    }
  });

  it('updates incrementally: skips unchanged files, re-indexes edits, and prunes deletions', () => {
    const dbPath = path.join(tmpDir, '.taskforge', 'repo-index.db');
    const indexer = new RepositoryIndexer(tmpDir, { databasePath: dbPath });
    try {
      const first = indexer.index();
      expect(first.updatedFiles).toBe(5);

      const second = indexer.index();
      expect(second.updatedFiles).toBe(0);
      expect(second.removedFiles).toBe(0);

      // Modify invoice.ts (bump size + mtime)
      fs.writeFileSync(
        path.join(tmpDir, 'src/billing/invoice.ts'),
        `export class InvoiceCalculator {
  computeTotal(cents: number): number { return cents; }
  applyCouponDiscount(code: string): number { return code.length; }
}
`,
      );
      const third = indexer.index();
      expect(third.updatedFiles).toBe(1);
      expect(indexer.search('coupon discount')[0]?.path).toBe('src/billing/invoice.ts');

      // Delete python/retry_policy.py from git tracking
      execFileSync('git', ['rm', '-q', 'python/retry_policy.py'], { cwd: tmpDir });
      const fourth = indexer.index();
      expect(fourth.removedFiles).toBe(1);
      expect(fourth.indexedFiles).toBe(4);
      expect(indexer.search('BackoffPolicy')).toEqual([]);
    } finally {
      indexer.close();
    }
  });

  it('resolves import graph edges and links related tests to source files', () => {
    const indexer = new RepositoryIndexer(tmpDir, { databasePath: ':memory:' });
    try {
      indexer.index();

      expect(indexer.getImports('src/http/middleware.ts')).toEqual(['src/auth/jwt.ts']);
      expect(indexer.getImportedBy('src/auth/jwt.ts')).toEqual([
        'src/http/middleware.ts',
        'tests/auth/jwt.test.ts',
      ]);
      expect(indexer.findRelatedTests('src/auth/jwt.ts')).toEqual(['tests/auth/jwt.test.ts']);
    } finally {
      indexer.close();
    }
  });

  it('handles FTS5-hostile punctuation/operators safely without throwing', () => {
    const indexer = new RepositoryIndexer(tmpDir, { databasePath: ':memory:' });
    try {
      indexer.index();
      expect(indexer.search('NOT NEAR/2 "jwt" (verify*): [token]')).not.toHaveLength(0);
      expect(indexer.search('   ... --- !!!   ')).toEqual([]);
      expect(extractQueryTerms('fix verifyJwtToken in src/auth')).toContain('verify');
      expect(extractQueryTerms('fix verifyJwtToken in src/auth')).toContain('jwt');
    } finally {
      indexer.close();
    }
  });

  it('builds compact goal context with non-overlapping scopes and related tests', () => {
    const ctx = RepositoryIndexer.queryGoal(
      tmpDir,
      'fix JWT token verification and auth middleware expiration handling',
      { databasePath: ':memory:' },
    );

    expect(ctx.indexedFiles).toBe(5);
    expect(ctx.matches.map((m) => m.path)).toContain('src/auth/jwt.ts');
    expect(ctx.matches.map((m) => m.path)).toContain('src/http/middleware.ts');
    expect(ctx.suggestedScopes).toContain('src/auth/**');
    expect(ctx.suggestedScopes).toContain('src/http/**');
    expect(ctx.relatedTests).toContain('tests/auth/jwt.test.ts');
    expect(ctx.summaryLines.some((l) => l.includes('src/auth/jwt.ts') && l.includes('tests: tests/auth/jwt.test.ts'))).toBe(true);
  });

  it('enriches RepositoryAnalyzer.analyze() only when goalDescription is supplied', async () => {
    const analyzer = new RepositoryAnalyzer(tmpDir);
    const plain = await analyzer.analyze();
    expect(plain.indexContext).toBeUndefined();

    const enriched = await analyzer.analyze({
      goalDescription: 'update InvoiceCalculator rounding rules',
    });
    expect(enriched.indexContext).toBeDefined();
    expect(enriched.indexContext?.matches[0]?.path).toBe('src/billing/invoice.ts');
    expect(enriched.indexContext?.suggestedScopes).toContain('src/billing/**');
  });

  it('recognizes test file patterns and extracts Rust/Go symbols', () => {
    expect(isTestFilePath('src/auth.test.ts')).toBe(true);
    expect(isTestFilePath('tests/test_login.py')).toBe(true);
    expect(isTestFilePath('pkg/handler_test.go')).toBe(true);
    expect(isTestFilePath('src/auth.ts')).toBe(false);

    expect(
      extractSymbols('pub struct SessionStore {}\npub async fn open_session() {}', '.rs'),
    ).toEqual(['open_session', 'SessionStore']);
    expect(extractSymbols('type Router struct {}\nfunc (r *Router) Handle() {}', '.go')).toEqual([
      'Handle',
      'Router',
    ]);
  });
});
