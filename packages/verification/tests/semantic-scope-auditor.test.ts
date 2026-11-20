import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  diffSemanticSurface,
  auditGitCommitSemanticBoundary,
} from '../src/semantic-scope-auditor.js';

describe('SemanticScopeAuditor (TypeScript AST boundary checks)', () => {
  it('flags breaking changes to exported interfaces while allowing additive optional members', () => {
    const before = `
      export interface UserSession {
        id: string;
        token: string;
        expiresAt?: number;
      }
    `;

    // Additive optional field + formatting/comments: non-breaking
    const nonBreaking = `
      // Added optional metadata field
      export interface UserSession {
        id: string;
        token: string;
        expiresAt?: number;
        locale?: string;
      }
    `;
    expect(diffSemanticSurface('src/types.ts', before, nonBreaking)).toEqual([]);

    // Removing a member, adding a required member, tightening optional -> required, and changing type
    const breaking = `
      export interface UserSession {
        id: number;
        expiresAt: number;
        tenantId: string;
      }
    `;
    const violations = diffSemanticSurface('src/types.ts', before, breaking);
    const kinds = new Map(violations.map((v) => [v.symbol, v.kind]));
    expect(kinds.get('UserSession.token')).toBe('interface_member_removed');
    expect(kinds.get('UserSession.id')).toBe('interface_member_type_changed');
    expect(kinds.get('UserSession.expiresAt')).toBe('interface_member_type_changed');
    expect(kinds.get('UserSession.tenantId')).toBe('interface_required_member_added');
  });

  it('flags breaking exported function, class, type alias, and enum changes while allowing body-only or optional-param edits', () => {
    const before = `
      export type Mode = 'fast' | 'safe';
      export enum Role { Admin = 'admin', User = 'user' }
      export function greet(name: string): string {
        return 'hi ' + name;
      }
      export class Store {
        private secret = 1;
        public get(key: string): string | undefined {
          return key;
        }
      }
    `;

    const nonBreaking = `
      export type Mode = 'fast' | 'safe';
      export enum Role { Admin = 'admin', User = 'user', Auditor = 'auditor' }
      export function greet(name: string, punctuation?: string): string {
        return 'hello ' + name + (punctuation ?? '!');
      }
      export class Store {
        private secret = 2;
        public get(key: string, fallback?: string): string | undefined {
          return fallback ?? key;
        }
        public set(key: string, val: string): void {
          void key; void val;
        }
      }
      export function extraHelper(): void {}
    `;
    expect(diffSemanticSurface('src/api.ts', before, nonBreaking)).toEqual([]);

    const breaking = `
      export type Mode = 'fast';
      export enum Role { Admin = 'admin' }
      export function greet(name: string, loud: boolean): number {
        return loud ? name.length : 0;
      }
      export class Store {
        public get(key: number): string | undefined {
          return String(key);
        }
      }
    `;
    const violations = diffSemanticSurface('src/api.ts', before, breaking);
    const kinds = new Map(violations.map((v) => [v.symbol, v.kind]));
    expect(kinds.get('Mode')).toBe('type_alias_changed');
    expect(kinds.get('Role.User')).toBe('enum_member_removed');
    expect(kinds.get('greet')).toBe('function_signature_changed');
    expect(kinds.get('Store.get')).toBe('class_method_signature_changed');
  });

  it('flags removed exports', () => {
    const before = `export function keepMe(): void {}\nexport const VERSION = '1.0';`;
    const after = `function keepMe(): void {}`;
    const violations = diffSemanticSurface('src/index.ts', before, after);
    expect(violations.map((v) => v.symbol).sort()).toEqual(['VERSION', 'keepMe']);
    expect(violations.every((v) => v.kind === 'exported_symbol_removed')).toBe(true);
  });

  it('detects modified unexported internal functions when blockOnUnexportedChanges or allowedSymbols is enabled', () => {
    const before = `
      function internalChecksum(input: string): number {
        return input.length;
      }
      export function publicHash(input: string): number {
        return internalChecksum(input);
      }
    `;
    const after = `
      function internalChecksum(input: string): number {
        return input.length * 2;
      }
      export function publicHash(input: string): number {
        return internalChecksum(input);
      }
    `;

    // Default: unexported changes allowed
    expect(diffSemanticSurface('src/hash.ts', before, after)).toEqual([]);

    // Opt-in unexported guard
    const unexportedViolations = diffSemanticSurface('src/hash.ts', before, after, {
      blockOnUnexportedChanges: true,
    });
    expect(unexportedViolations).toHaveLength(1);
    expect(unexportedViolations[0]).toMatchObject({
      symbol: 'internalChecksum',
      kind: 'unexported_symbol_modified',
    });

    // Explicit symbol allow-list
    const scopeViolations = diffSemanticSurface('src/hash.ts', before, after, {
      allowedSymbols: ['publicHash'],
    });
    expect(scopeViolations).toHaveLength(1);
    expect(scopeViolations[0]).toMatchObject({
      symbol: 'internalChecksum',
      kind: 'symbol_outside_scope',
    });
  });

  describe('auditGitCommitSemanticBoundary', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ast-audit-'));
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
      fs.mkdirSync(path.join(tmpDir, 'packages/shared'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'packages/app'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'packages/shared/contract.ts'),
        'export interface SharedConfig { host: string; port: number; }\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'packages/app/main.ts'),
        'export function run(x: string): string { return x; }\n',
      );
      execFileSync('git', ['add', '-A'], { cwd: tmpDir });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: tmpDir });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('audits git commits and respects configured scope filters', () => {
      const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf8',
      }).trim();

      // Break shared contract, keep app non-breaking
      fs.writeFileSync(
        path.join(tmpDir, 'packages/shared/contract.ts'),
        'export interface SharedConfig { host: string; }\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'packages/app/main.ts'),
        'export function run(x: string): string { return x.trim(); }\n',
      );
      execFileSync('git', ['add', '-A'], { cwd: tmpDir });
      execFileSync('git', ['commit', '-q', '-m', 'change'], { cwd: tmpDir });
      const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf8',
      }).trim();

      const fullAudit = auditGitCommitSemanticBoundary({
        worktreePath: tmpDir,
        baseCommit,
        commitHash: headCommit,
        changedFiles: ['packages/shared/contract.ts', 'packages/app/main.ts'],
      });
      expect(fullAudit.passed).toBe(false);
      expect(fullAudit.auditedFiles).toBe(2);
      expect(fullAudit.violations).toHaveLength(1);
      expect(fullAudit.violations[0]).toMatchObject({
        file: 'packages/shared/contract.ts',
        symbol: 'SharedConfig.port',
        kind: 'interface_member_removed',
      });

      // Auditing only packages/app/** passes because the breaking edit is outside that scope
      const scopedAudit = auditGitCommitSemanticBoundary({
        worktreePath: tmpDir,
        baseCommit,
        commitHash: headCommit,
        changedFiles: ['packages/shared/contract.ts', 'packages/app/main.ts'],
        options: { scopes: ['packages/app/**'] },
      });
      expect(scopedAudit.passed).toBe(true);
      expect(scopedAudit.auditedFiles).toBe(1);
    });
  });
});
