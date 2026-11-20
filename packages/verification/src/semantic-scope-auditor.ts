import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

export type SemanticViolationKind =
  | 'exported_symbol_removed'
  | 'interface_member_removed'
  | 'interface_required_member_added'
  | 'interface_member_type_changed'
  | 'type_alias_changed'
  | 'enum_member_removed'
  | 'function_signature_changed'
  | 'class_member_removed'
  | 'class_method_signature_changed'
  | 'unexported_symbol_modified'
  | 'unexported_symbol_removed'
  | 'symbol_outside_scope';

export interface SemanticBoundaryViolation {
  file: string;
  symbol: string;
  kind: SemanticViolationKind;
  detail: string;
}

export interface SemanticAuditOptions {
  blockOnBreakingExports?: boolean;
  blockOnUnexportedChanges?: boolean;
  /** Optional explicit allow-list of top-level symbol names this task is allowed to alter. */
  allowedSymbols?: string[];
  /** Optional glob scopes restricting which files are audited (empty = all TS/JS files). */
  scopes?: string[];
}

export interface SemanticAuditReport {
  passed: boolean;
  auditedFiles: number;
  violations: SemanticBoundaryViolation[];
  summary: string;
}

interface ParamDescriptor {
  optional: boolean;
  rest: boolean;
  typeText: string;
}

interface FunctionDescriptor {
  kind: 'function';
  params: ParamDescriptor[];
  returnType: string;
}

interface InterfaceMemberDescriptor {
  optional: boolean;
  signature: string;
}

interface InterfaceDescriptor {
  kind: 'interface';
  members: Map<string, InterfaceMemberDescriptor>;
}

interface TypeAliasDescriptor {
  kind: 'type';
  typeText: string;
}

interface EnumDescriptor {
  kind: 'enum';
  members: Map<string, string>;
}

interface ClassMemberDescriptor {
  kind: 'method' | 'property';
  signature: string;
  params?: ParamDescriptor[];
  returnType?: string;
}

interface ClassDescriptor {
  kind: 'class';
  members: Map<string, ClassMemberDescriptor>;
}

interface ConstDescriptor {
  kind: 'const';
  typeText: string;
}

type ExportedSymbolDescriptor =
  | FunctionDescriptor
  | InterfaceDescriptor
  | TypeAliasDescriptor
  | EnumDescriptor
  | ClassDescriptor
  | ConstDescriptor;

interface UnexportedSymbolDescriptor {
  kind: 'function' | 'class' | 'variable';
  normalizedBody: string;
}

export interface FileAstSurface {
  filePath: string;
  exports: Map<string, ExportedSymbolDescriptor>;
  unexported: Map<string, UnexportedSymbolDescriptor>;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

export function isSemanticAuditableFile(filePath: string): boolean {
  const ext = path.posix.extname(filePath.replace(/\\/g, '/')).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function normalizeWs(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function isPrivateClassMember(node: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return true;
  if (node.name && ts.isPrivateIdentifier(node.name)) return true;
  return false;
}

function extractParams(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  sf: ts.SourceFile,
): ParamDescriptor[] {
  return params.map((p) => ({
    optional: Boolean(p.questionToken || p.initializer),
    rest: Boolean(p.dotDotDotToken),
    typeText: p.type ? normalizeWs(p.type.getText(sf)) : 'unknown',
  }));
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = path.posix.extname(filePath).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function memberNameText(name: ts.PropertyName | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return normalizeWs(name.getText(sf));
}

/** Parses a TS/JS source file with the TypeScript Compiler API and extracts its semantic surface. */
export function extractFileAstSurface(filePath: string, source: string): FileAstSurface {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const exports = new Map<string, ExportedSymbolDescriptor>();
  const unexported = new Map<string, UnexportedSymbolDescriptor>();

  for (const stmt of sf.statements) {
    const exported = hasExportModifier(stmt);

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      if (exported) {
        exports.set(name, {
          kind: 'function',
          params: extractParams(stmt.parameters, sf),
          returnType: stmt.type ? normalizeWs(stmt.type.getText(sf)) : '',
        });
      } else {
        unexported.set(name, {
          kind: 'function',
          normalizedBody: normalizeWs(stmt.getText(sf)),
        });
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(stmt)) {
      const name = stmt.name.text;
      if (exported) {
        const members = new Map<string, InterfaceMemberDescriptor>();
        for (const m of stmt.members) {
          if (ts.isPropertySignature(m) || ts.isMethodSignature(m)) {
            const mName = memberNameText(m.name, sf);
            if (!mName) continue;
            const signature = ts.isPropertySignature(m)
              ? m.type
                ? normalizeWs(m.type.getText(sf))
                : 'unknown'
              : `(${extractParams(m.parameters, sf)
                  .map((p) => `${p.rest ? '...' : ''}${p.optional ? '?' : ''}:${p.typeText}`)
                  .join(', ')}) => ${m.type ? normalizeWs(m.type.getText(sf)) : 'unknown'}`;
            members.set(mName, {
              optional: Boolean(m.questionToken),
              signature,
            });
          }
        }
        exports.set(name, { kind: 'interface', members });
      }
      continue;
    }

    if (ts.isTypeAliasDeclaration(stmt)) {
      const name = stmt.name.text;
      if (exported) {
        exports.set(name, {
          kind: 'type',
          typeText: normalizeWs(stmt.type.getText(sf)),
        });
      }
      continue;
    }

    if (ts.isEnumDeclaration(stmt)) {
      const name = stmt.name.text;
      if (exported) {
        const members = new Map<string, string>();
        for (const m of stmt.members) {
          const mName = memberNameText(m.name, sf);
          if (!mName) continue;
          members.set(mName, m.initializer ? normalizeWs(m.initializer.getText(sf)) : '');
        }
        exports.set(name, { kind: 'enum', members });
      }
      continue;
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      if (exported) {
        const members = new Map<string, ClassMemberDescriptor>();
        for (const m of stmt.members) {
          if (isPrivateClassMember(m)) continue;
          if (ts.isMethodDeclaration(m)) {
            const mName = memberNameText(m.name, sf);
            if (!mName) continue;
            const params = extractParams(m.parameters, sf);
            const returnType = m.type ? normalizeWs(m.type.getText(sf)) : '';
            members.set(mName, {
              kind: 'method',
              params,
              returnType,
              signature: `(${params.map((p) => `${p.rest ? '...' : ''}${p.optional ? '?' : ''}:${p.typeText}`).join(', ')}) => ${returnType}`,
            });
          } else if (ts.isPropertyDeclaration(m)) {
            const mName = memberNameText(m.name, sf);
            if (!mName) continue;
            members.set(mName, {
              kind: 'property',
              signature: `${m.questionToken ? '?' : ''}:${m.type ? normalizeWs(m.type.getText(sf)) : ''}`,
            });
          }
        }
        exports.set(name, { kind: 'class', members });
      } else {
        unexported.set(name, {
          kind: 'class',
          normalizedBody: normalizeWs(stmt.getText(sf)),
        });
      }
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (exported) {
          if (
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            exports.set(name, {
              kind: 'function',
              params: extractParams(decl.initializer.parameters, sf),
              returnType: decl.initializer.type
                ? normalizeWs(decl.initializer.type.getText(sf))
                : '',
            });
          } else {
            exports.set(name, {
              kind: 'const',
              typeText: decl.type ? normalizeWs(decl.type.getText(sf)) : '',
            });
          }
        } else if (
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          unexported.set(name, {
            kind: 'variable',
            normalizedBody: normalizeWs(decl.getText(sf)),
          });
        }
      }
    }
  }

  return { filePath, exports, unexported };
}

function isBreakingParamChange(before: ParamDescriptor[], after: ParamDescriptor[]): string | undefined {
  const beforeRequired = before.filter((p) => !p.optional && !p.rest).length;
  const afterRequired = after.filter((p) => !p.optional && !p.rest).length;
  if (afterRequired > beforeRequired) {
    return `required parameter count increased from ${beforeRequired} to ${afterRequired}`;
  }

  const shared = Math.min(before.length, after.length);
  for (let i = 0; i < shared; i++) {
    const b = before[i];
    const a = after[i];
    if (b.optional && !a.optional && !a.rest) {
      return `parameter #${i + 1} changed from optional to required`;
    }
    if (b.typeText !== a.typeText) {
      return `parameter #${i + 1} type changed from "${b.typeText}" to "${a.typeText}"`;
    }
  }
  return undefined;
}

/**
 * Compares the before/after AST surfaces of a single file and returns any
 * breaking exported API changes, disallowed unexported modifications, or
 * out-of-scope symbol edits.
 */
export function diffSemanticSurface(
  filePath: string,
  beforeSource: string | undefined,
  afterSource: string | undefined,
  options: SemanticAuditOptions = {},
): SemanticBoundaryViolation[] {
  if (!isSemanticAuditableFile(filePath)) return [];
  if (beforeSource === undefined) return []; // brand-new file cannot break existing contracts

  const blockBreaking = options.blockOnBreakingExports !== false;
  const blockUnexported = options.blockOnUnexportedChanges === true;
  const allowedSymbols =
    options.allowedSymbols && options.allowedSymbols.length > 0
      ? new Set(options.allowedSymbols)
      : undefined;

  const before = extractFileAstSurface(filePath, beforeSource);
  const after = extractFileAstSurface(filePath, afterSource ?? '');
  const violations: SemanticBoundaryViolation[] = [];

  if (blockBreaking) {
    for (const [name, prev] of before.exports) {
      const next = after.exports.get(name);
      if (!next) {
        violations.push({
          file: filePath,
          symbol: name,
          kind: 'exported_symbol_removed',
          detail: `Exported ${prev.kind} "${name}" was removed or un-exported.`,
        });
        continue;
      }

      if (prev.kind !== next.kind) {
        violations.push({
          file: filePath,
          symbol: name,
          kind: 'exported_symbol_removed',
          detail: `Exported symbol "${name}" changed kind from ${prev.kind} to ${next.kind}.`,
        });
        continue;
      }

      if (prev.kind === 'interface' && next.kind === 'interface') {
        for (const [memberName, prevMember] of prev.members) {
          const nextMember = next.members.get(memberName);
          if (!nextMember) {
            violations.push({
              file: filePath,
              symbol: `${name}.${memberName}`,
              kind: 'interface_member_removed',
              detail: `Member "${memberName}" was removed from exported interface "${name}".`,
            });
          } else if (prevMember.optional && !nextMember.optional) {
            violations.push({
              file: filePath,
              symbol: `${name}.${memberName}`,
              kind: 'interface_member_type_changed',
              detail: `Member "${memberName}" on exported interface "${name}" changed from optional to required.`,
            });
          } else if (prevMember.signature !== nextMember.signature) {
            violations.push({
              file: filePath,
              symbol: `${name}.${memberName}`,
              kind: 'interface_member_type_changed',
              detail: `Member "${memberName}" on exported interface "${name}" changed type from "${prevMember.signature}" to "${nextMember.signature}".`,
            });
          }
        }
        for (const [memberName, nextMember] of next.members) {
          if (!prev.members.has(memberName) && !nextMember.optional) {
            violations.push({
              file: filePath,
              symbol: `${name}.${memberName}`,
              kind: 'interface_required_member_added',
              detail: `Required member "${memberName}" was added to exported interface "${name}" (make it optional with "?" to avoid breaking consumers).`,
            });
          }
        }
      } else if (prev.kind === 'type' && next.kind === 'type') {
        if (prev.typeText !== next.typeText) {
          violations.push({
            file: filePath,
            symbol: name,
            kind: 'type_alias_changed',
            detail: `Exported type "${name}" changed from "${prev.typeText}" to "${next.typeText}".`,
          });
        }
      } else if (prev.kind === 'enum' && next.kind === 'enum') {
        for (const [memberName] of prev.members) {
          if (!next.members.has(memberName)) {
            violations.push({
              file: filePath,
              symbol: `${name}.${memberName}`,
              kind: 'enum_member_removed',
              detail: `Member "${memberName}" was removed from exported enum "${name}".`,
            });
          }
        }
      } else if (prev.kind === 'function' && next.kind === 'function') {
        const paramReason = isBreakingParamChange(prev.params, next.params);
        if (paramReason) {
          violations.push({
            file: filePath,
            symbol: name,
            kind: 'function_signature_changed',
            detail: `Exported function "${name}" signature broke: ${paramReason}.`,
          });
        } else if (prev.returnType && prev.returnType !== next.returnType) {
          violations.push({
            file: filePath,
            symbol: name,
            kind: 'function_signature_changed',
            detail: `Exported function "${name}" return type changed from "${prev.returnType}" to "${next.returnType || '(inferred)'}".`,
          });
        }
      } else if (prev.kind === 'class' && next.kind === 'class') {
        for (const [memberName, prevMember] of prev.members) {
          const nextMember = next.members.get(memberName);
          if (!nextMember) {
            violations.push({
              file: filePath,
              symbol: `${name}.${memberName}`,
              kind: 'class_member_removed',
              detail: `Public ${prevMember.kind} "${memberName}" was removed from exported class "${name}".`,
            });
            continue;
          }
          if (
            prevMember.kind === 'method' &&
            nextMember.kind === 'method' &&
            prevMember.params &&
            nextMember.params
          ) {
            const paramReason = isBreakingParamChange(prevMember.params, nextMember.params);
            if (paramReason) {
              violations.push({
                file: filePath,
                symbol: `${name}.${memberName}`,
                kind: 'class_method_signature_changed',
                detail: `Public method "${name}.${memberName}" signature broke: ${paramReason}.`,
              });
            } else if (prevMember.returnType && prevMember.returnType !== nextMember.returnType) {
              violations.push({
                file: filePath,
                symbol: `${name}.${memberName}`,
                kind: 'class_method_signature_changed',
                detail: `Public method "${name}.${memberName}" return type changed from "${prevMember.returnType}" to "${nextMember.returnType || '(inferred)'}".`,
              });
            }
          }
        }
      } else if (prev.kind === 'const' && next.kind === 'const') {
        if (prev.typeText && prev.typeText !== next.typeText) {
          violations.push({
            file: filePath,
            symbol: name,
            kind: 'type_alias_changed',
            detail: `Exported constant "${name}" type changed from "${prev.typeText}" to "${next.typeText || '(inferred)'}".`,
          });
        }
      }
    }
  }

  if (blockUnexported || allowedSymbols) {
    for (const [name, prev] of before.unexported) {
      const next = after.unexported.get(name);
      if (!next) {
        if (blockUnexported || (allowedSymbols && !allowedSymbols.has(name))) {
          violations.push({
            file: filePath,
            symbol: name,
            kind: allowedSymbols && !allowedSymbols.has(name)
              ? 'symbol_outside_scope'
              : 'unexported_symbol_removed',
            detail: `Unexported internal ${prev.kind} "${name}" was removed.`,
          });
        }
      } else if (prev.normalizedBody !== next.normalizedBody) {
        if (blockUnexported || (allowedSymbols && !allowedSymbols.has(name))) {
          violations.push({
            file: filePath,
            symbol: name,
            kind: allowedSymbols && !allowedSymbols.has(name)
              ? 'symbol_outside_scope'
              : 'unexported_symbol_modified',
            detail: `Unexported internal ${prev.kind} "${name}" was modified.`,
          });
        }
      }
    }
  }

  return violations;
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '*' || normalized === '**') return /^.*$/;
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function matchesAnyScope(filePath: string, scopes?: string[]): boolean {
  if (!scopes || scopes.length === 0) return true;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return scopes.some((scope) => globToRegExp(scope).test(normalized));
}

function readGitFileAtCommit(cwd: string, commit: string, filePath: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${commit}:${filePath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

export interface GitSemanticAuditParams {
  worktreePath: string;
  baseCommit: string;
  commitHash: string;
  changedFiles: string[];
  options?: SemanticAuditOptions;
}

/**
 * Audits all changed TS/JS files between `baseCommit` and `commitHash` for
 * breaking AST signature changes or protected internal modifications.
 */
export function auditGitCommitSemanticBoundary(
  params: GitSemanticAuditParams,
): SemanticAuditReport {
  const options = params.options ?? {};
  const violations: SemanticBoundaryViolation[] = [];
  let auditedFiles = 0;

  for (const file of params.changedFiles) {
    if (!isSemanticAuditableFile(file)) continue;
    if (!matchesAnyScope(file, options.scopes)) continue;
    auditedFiles += 1;
    const before = readGitFileAtCommit(params.worktreePath, params.baseCommit, file);
    const after = readGitFileAtCommit(params.worktreePath, params.commitHash, file);
    violations.push(...diffSemanticSurface(file, before, after, options));
  }

  return {
    passed: violations.length === 0,
    auditedFiles,
    violations,
    summary:
      violations.length === 0
        ? `Semantic AST audit passed across ${auditedFiles} file(s).`
        : `Semantic AST audit found ${violations.length} violation(s) across ${auditedFiles} file(s).`,
  };
}
