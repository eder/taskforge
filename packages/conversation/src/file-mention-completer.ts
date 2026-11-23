import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.taskforge',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'target',
]);

const fileCache = new Map<string, { files: string[]; expiresAt: number }>();

/**
 * Lists repository-relative files for fast `#file` Tab autocomplete.
 * Uses `git ls-files` when inside a git repo (respecting `.gitignore`), with a
 * bounded filesystem walk fallback otherwise. Cached briefly per repoRoot.
 */
export function listRepositoryFiles(repoRoot: string, maxFiles = 4000): string[] {
  const now = Date.now();
  const cached = fileCache.get(repoRoot);
  if (cached && cached.expiresAt > now) {
    return cached.files;
  }

  let files: string[] = [];
  try {
    const raw = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    files = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('.taskforge/'))
      .slice(0, maxFiles);
  } catch {
    files = walkFilesFallback(repoRoot, maxFiles);
  }

  fileCache.set(repoRoot, { files, expiresAt: now + 5000 });
  return files;
}

/** Clears cached file listings (useful in tests after adding files). */
export function clearFileMentionCache(repoRoot?: string): void {
  if (repoRoot) fileCache.delete(repoRoot);
  else fileCache.clear();
}

function walkFilesFallback(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && out.length < maxFiles) {
    const relDir = stack.pop()!;
    const absDir = relDir ? path.join(root, relDir) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

export interface FileMentionCompletion {
  nextBuffer: string;
  nextCursor: number;
  matches: string[];
  completed?: string;
}

/**
 * Autocompletes `#<partial-path>` tokens right before `cursorIndex` in the REPL
 * prompt without colliding with `@agent` mentions.
 */
export function completeFileMentionAtCursor(
  buffer: string,
  cursorIndex: number,
  repoFiles: readonly string[],
): FileMentionCompletion | undefined {
  const before = buffer.slice(0, cursorIndex);
  const after = buffer.slice(cursorIndex);
  const tokenMatch = /(?:^|\s)(#([^\s]*))$/.exec(before);
  if (!tokenMatch) return undefined;

  const rawToken = tokenMatch[1]; // e.g. "#mem"
  const query = tokenMatch[2].toLowerCase();
  const tokenStart = cursorIndex - rawToken.length;

  const scored: Array<{ file: string; rank: number }> = [];
  for (const file of repoFiles) {
    const lower = file.toLowerCase();
    const base = path.posix.basename(lower);
    if (!query) {
      scored.push({ file, rank: 3 });
    } else if (lower.startsWith(query)) {
      scored.push({ file, rank: 0 });
    } else if (base.startsWith(query)) {
      scored.push({ file, rank: 1 });
    } else if (lower.includes(query)) {
      scored.push({ file, rank: 2 });
    }
  }

  if (scored.length === 0) return undefined;

  scored.sort((a, b) => a.rank - b.rank || a.file.length - b.file.length || a.file.localeCompare(b.file));
  const matches = scored.slice(0, 8).map((s) => s.file);

  if (matches.length === 1) {
    const inserted = `#${matches[0]} `;
    const nextBuffer = buffer.slice(0, tokenStart) + inserted + after.replace(/^\s*/, '');
    return {
      nextBuffer,
      nextCursor: tokenStart + inserted.length,
      matches,
      completed: matches[0],
    };
  }

  // Expand to longest common prefix if strictly longer than what the user typed
  const lcp = longestCommonPrefix(matches);
  if (lcp.length > query.length) {
    const inserted = `#${lcp}`;
    const nextBuffer = buffer.slice(0, tokenStart) + inserted + after;
    return {
      nextBuffer,
      nextCursor: tokenStart + inserted.length,
      matches,
    };
  }

  return {
    nextBuffer: buffer,
    nextCursor: cursorIndex,
    matches,
  };
}

function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return '';
  let prefix = items[0];
  for (let i = 1; i < items.length; i++) {
    const current = items[i];
    let j = 0;
    while (j < prefix.length && j < current.length && prefix[j] === current[j]) {
      j++;
    }
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|svg|bmp)$/i;

/**
 * Extracts validated repo-relative `#path/to/file` references AND local image
 * attachments (`#screenshot.png` or dragged absolute image paths like
 * `/Users/.../error.png`) from a prompt.
 */
export function resolveFileMentionsInPrompt(
  prompt: string,
  repoRoot: string,
): { cleanedPrompt: string; files: string[]; images: string[] } {
  const resolvedRoot = path.resolve(repoRoot);
  const found: string[] = [];
  const images: string[] = [];
  const seen = new Set<string>();
  const seenImages = new Set<string>();

  const cleanedPrompt = prompt.replace(/(^|\s)#([^\s,;()[\]{}]+)/g, (full, lead: string, candidate: string) => {
    // Strip trailing punctuation like `?`, `.`, `,`, `:`
    const trailingMatch = /^(.*?)([.,;:!?]+)$/.exec(candidate);
    const rawPath = trailingMatch ? trailingMatch[1] : candidate;
    const trailing = trailingMatch ? trailingMatch[2] : '';

    if (!rawPath || rawPath.startsWith('#') || /^\d+$/.test(rawPath)) {
      return full;
    }

    // Allow explicit `#/abs/path/to/screenshot.png` for images outside repoRoot
    if (rawPath.startsWith('/') && IMAGE_EXT_RE.test(rawPath) && fs.existsSync(rawPath)) {
      if (!seenImages.has(rawPath)) {
        seenImages.add(rawPath);
        images.push(rawPath);
      }
      return `${lead}${rawPath}${trailing}`;
    }

    const normalized = rawPath.replace(/^\.\//, '').replace(/^\/+/, '');
    const abs = path.resolve(resolvedRoot, normalized);
    if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
      return full;
    }
    if (!fs.existsSync(abs)) {
      return full;
    }
    const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
    if (IMAGE_EXT_RE.test(rel)) {
      if (!seenImages.has(abs)) {
        seenImages.add(abs);
        images.push(abs);
      }
    }
    if (!seen.has(rel)) {
      seen.add(rel);
      found.push(rel);
    }
    return `${lead}${rel}${trailing}`;
  });

  // Also detect standalone absolute image paths pasted/dragged into the terminal
  const absImageRe = /(?:^|\s)(\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif|svg|bmp))(?=$|\s|[.,;:!?])/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = absImageRe.exec(cleanedPrompt)) !== null) {
    const absPath = imgMatch[1];
    if (fs.existsSync(absPath) && !seenImages.has(absPath)) {
      seenImages.add(absPath);
      images.push(absPath);
    }
  }

  return { cleanedPrompt, files: found, images };
}

/** Formats attached image paths into a concise prompt block for multimodal coding agents. */
export function appendImageContextToPrompt(prompt: string, images: readonly string[]): string {
  if (images.length === 0) return prompt;
  const block = [
    '',
    'Attached image file(s) to inspect directly:',
    ...images.map((img) => `- ${img}`),
  ].join('\n');
  return `${prompt}${block}`;
}
