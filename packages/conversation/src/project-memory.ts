import * as fs from 'node:fs';
import * as path from 'node:path';
import { colors } from './theme.js';

export interface ProjectMemoryEntry {
  id: number;
  category: 'decision' | 'convention' | 'preference' | 'council' | 'blueprint';
  text: string;
  createdAt: string;
}

const MEMORY_REL_PATH = path.join('.taskforge', 'memory.md');

export function getProjectMemoryPath(repoRoot: string): string {
  return path.join(repoRoot, MEMORY_REL_PATH);
}

/**
 * Parses durable project memory entries from `.taskforge/memory.md`.
 * Format: `- [category] fact text  <!-- 2026-... -->`
 */
export function loadProjectMemory(repoRoot: string): ProjectMemoryEntry[] {
  const filePath = getProjectMemoryPath(repoRoot);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries: ProjectMemoryEntry[] = [];
    for (const line of raw.split('\n')) {
      const m = /^-\s+\[(decision|convention|preference|council|blueprint)\]\s+(.+?)(?:\s*<!--\s*([^>]+?)\s*-->)?\s*$/.exec(
        line.trim(),
      );
      if (m) {
        entries.push({
          id: entries.length + 1,
          category: m[1] as ProjectMemoryEntry['category'],
          text: m[2].trim(),
          createdAt: m[3]?.trim() || new Date().toISOString(),
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function saveProjectMemory(repoRoot: string, entries: readonly ProjectMemoryEntry[]): string {
  const filePath = getProjectMemoryPath(repoRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines: string[] = [
    '# TaskForge Project Memory',
    '',
    '> Durable decisions, conventions, and preferences shared across all agents (`claude`, `codex`, `agy`).',
    '> Edit this file directly or manage via `/memory` in `tf`.',
    '',
  ];
  for (const e of entries) {
    lines.push(`- [${e.category}] ${e.text.replace(/\s+/g, ' ').trim()} <!-- ${e.createdAt} -->`);
  }
  lines.push('');
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, lines.join('\n'), 'utf8');
  fs.renameSync(temp, filePath);
  return filePath;
}

export function addProjectMemoryEntry(
  repoRoot: string,
  text: string,
  category: ProjectMemoryEntry['category'] = 'preference',
): { entry: ProjectMemoryEntry; duplicate: boolean; total: number } {
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 280);
  const existing = loadProjectMemory(repoRoot);
  const dup = existing.find((e) => e.text.toLowerCase() === cleaned.toLowerCase());
  if (dup) {
    return { entry: dup, duplicate: true, total: existing.length };
  }
  const entry: ProjectMemoryEntry = {
    id: existing.length + 1,
    category,
    text: cleaned,
    createdAt: new Date().toISOString(),
  };
  const next = [...existing, entry].slice(-50);
  saveProjectMemory(repoRoot, next);
  return { entry, duplicate: false, total: next.length };
}

export function removeProjectMemoryEntry(repoRoot: string, indexOneBased: number): boolean {
  const existing = loadProjectMemory(repoRoot);
  if (indexOneBased < 1 || indexOneBased > existing.length) return false;
  const next = existing.filter((_, idx) => idx !== indexOneBased - 1);
  saveProjectMemory(repoRoot, next);
  return true;
}

export function clearProjectMemory(repoRoot: string): boolean {
  const filePath = getProjectMemoryPath(repoRoot);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

/** Formats durable project memory into a compact context header injected into all agents. */
export function formatProjectMemoryForPrompt(repoRoot: string, maxChars = 2400): string | undefined {
  const entries = loadProjectMemory(repoRoot);
  if (entries.length === 0) return undefined;
  const lines = ['Durable Project Memory (.taskforge/memory.md — honor across all tasks):'];
  let used = lines[0].length;
  for (const e of entries) {
    const row = `- [${e.category}] ${e.text}`;
    if (used + row.length + 1 > maxChars) break;
    lines.push(row);
    used += row.length + 1;
  }
  return lines.join('\n');
}

export function formatProjectMemoryDisplay(repoRoot: string): string {
  const entries = loadProjectMemory(repoRoot);
  if (entries.length === 0) {
    return [
      `${colors.dim}No durable project memory saved yet (.taskforge/memory.md).${colors.reset}`,
      `  ${colors.dim}Add with: /memory add <rule or decision>  or say "lembra que nesse projeto usamos Vitest"${colors.reset}`,
    ].join('\n');
  }
  const lines = [
    `${colors.brand}✦ ${colors.bold}Project Memory${colors.reset} ${colors.dim}(.taskforge/memory.md · ${entries.length} item${entries.length === 1 ? '' : 's'})${colors.reset}`,
  ];
  for (const e of entries) {
    lines.push(`  ${colors.cyan}#${e.id}${colors.reset} ${colors.dim}[${e.category}]${colors.reset} ${e.text}`);
  }
  lines.push(
    `  ${colors.dim}Manage: /memory add <text>  ·  /memory remove <#>  ·  /memory clear${colors.reset}`,
  );
  return lines.join('\n');
}

/**
 * Parses natural-language memory capture statements (PT & EN), e.g.:
 * - "lembra que nesse projeto usamos Vitest e não Jest"
 * - "anota que a API sempre retorna snake_case"
 * - "remember that this repo uses pnpm, never npm"
 */
export function parseNaturalMemoryCapture(
  rawText: string,
): { text: string; language: 'pt' | 'en' } | undefined {
  const text = rawText.trim();
  if (!text || text.startsWith('/') || text.startsWith('@') || text.startsWith('!') || text.length > 260) {
    return undefined;
  }
  if (text.endsWith('?')) return undefined;

  const ptMatch =
    /^(?:lembr[ae](?:-se)?|memoriz[ae]|anot[ae]|guard[ae])\s+(?:que|sempre\s+que)\s+(.{8,240})$/i.exec(text);
  if (ptMatch) {
    return { text: ptMatch[1].trim(), language: 'pt' };
  }

  const enMatch =
    /^(?:remember|memorize|note)\s+that\s+(.{8,240})$/i.exec(text);
  if (enMatch) {
    return { text: enMatch[1].trim(), language: 'en' };
  }

  return undefined;
}
