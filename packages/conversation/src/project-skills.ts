import * as fs from 'node:fs';
import * as path from 'node:path';
import { colors } from './theme.js';

export interface ProjectSkill {
  name: string;
  description: string;
  source: 'taskforge' | 'claude' | 'agents';
  filePath: string;
  body: string;
}

const SKILL_LOCATIONS: Array<{ relDir: string; source: ProjectSkill['source'] }> = [
  { relDir: path.join('.taskforge', 'skills'), source: 'taskforge' },
  { relDir: path.join('.claude', 'commands'), source: 'claude' },
  { relDir: path.join('.agents', 'skills'), source: 'agents' },
];

function parseFrontmatter(raw: string): { description?: string; body: string } {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!fmMatch) return { body: raw.trim() };
  const header = fmMatch[1];
  const body = fmMatch[2].trim();
  const descMatch = /^description\s*:\s*["']?(.+?)["']?\s*$/im.exec(header);
  return { description: descMatch?.[1]?.trim(), body };
}

function firstHeadingOrLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim().replace(/^#+\s*/, ''))
    .find((l) => l.length > 0);
  return (line || 'Custom project skill').slice(0, 90);
}

/**
 * Discovers reusable Markdown skills/commands across `.taskforge/skills/`,
 * `.claude/commands/`, and `.agents/skills/` so a single skill works with ANY
 * agent (`@codex`, `@agy`, `@claude`, `@all`, or `auto`).
 */
export function discoverProjectSkills(repoRoot: string): ProjectSkill[] {
  const byName = new Map<string, ProjectSkill>();

  for (const loc of SKILL_LOCATIONS) {
    const dir = path.join(repoRoot, loc.relDir);
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      let skillName: string | undefined;
      let filePath: string | undefined;

      if (entry.isFile() && entry.name.endsWith('.md')) {
        skillName = entry.name.replace(/\.md$/i, '').toLowerCase();
        filePath = path.join(dir, entry.name);
      } else if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, 'SKILL.md');
        if (fs.existsSync(nested)) {
          skillName = entry.name.toLowerCase();
          filePath = nested;
        }
      }

      if (!skillName || !filePath || byName.has(skillName)) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const { description, body } = parseFrontmatter(raw);
        if (!body) continue;
        byName.set(skillName, {
          name: skillName,
          description: description || firstHeadingOrLine(body),
          source: loc.source,
          filePath: path.relative(repoRoot, filePath) || filePath,
          body,
        });
      } catch {
        // ignore unreadable skill file
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findProjectSkill(repoRoot: string, name: string): ProjectSkill | undefined {
  const normalized = name.replace(/^\/+/, '').trim().toLowerCase();
  return discoverProjectSkills(repoRoot).find((s) => s.name === normalized);
}

/** Expands a skill template, replacing `$ARGUMENTS` / `{{args}}` or appending user arguments cleanly. */
export function expandSkillPrompt(skill: ProjectSkill, args: string): string {
  const trimmedArgs = args.trim();
  let expanded = skill.body;
  if (expanded.includes('$ARGUMENTS') || expanded.includes('{{args}}')) {
    expanded = expanded
      .replaceAll('$ARGUMENTS', trimmedArgs)
      .replaceAll('{{args}}', trimmedArgs);
  } else if (trimmedArgs) {
    expanded = `${expanded}\n\nAdditional user input:\n${trimmedArgs}`;
  }
  return `[Skill: /${skill.name} (${skill.filePath})]\n\n${expanded}`;
}

export function formatSkillsList(repoRoot: string): string {
  const skills = discoverProjectSkills(repoRoot);
  if (skills.length === 0) {
    return [
      `${colors.dim}No project skills found.${colors.reset}`,
      `  ${colors.dim}Create Markdown files in .taskforge/skills/<name>.md (or .claude/commands/ / .agents/skills/) and invoke via /skill <name> [@agent|@all] [args].${colors.reset}`,
    ].join('\n');
  }
  const lines = [
    `${colors.brand}✦ ${colors.bold}Project Skills${colors.reset} ${colors.dim}(${skills.length} discovered — usable with any agent)${colors.reset}`,
  ];
  for (const s of skills) {
    lines.push(
      `  • ${colors.cyan}/${s.name}${colors.reset} ${colors.dim}[${s.source}]${colors.reset} — ${s.description}`,
    );
  }
  lines.push(
    `  ${colors.dim}Run: /skill <name> [@codex|@agy|@claude|@all] [args]   or directly   /<name> [args]${colors.reset}`,
  );
  return lines.join('\n');
}
