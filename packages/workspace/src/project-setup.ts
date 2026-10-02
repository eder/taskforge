import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Project-level TaskForge configuration helpers.
 *
 * `.taskforge/config.yaml` is optional: without it TaskForge uses its defaults.
 * It only matters for things defaults cannot know, chiefly how to verify a
 * code change in a project that is not a Node project. These helpers detect
 * what a project needs and *propose* a file; nothing here writes without the
 * caller asking (see `tf init`).
 */

export const PROJECT_CONFIG_RELATIVE_PATH = path.join('.taskforge', 'config.yaml');
const HINTS_RELATIVE_PATH = path.join('.taskforge', 'hints.json');

export interface DetectedStack {
  /** Human label, e.g. "Python (pytest) in server/". */
  label: string;
  /** Verification commands to write into the config. Empty when TaskForge already discovers them. */
  commands: string[];
  /** TaskForge finds this stack's checks on its own (Node package.json scripts). */
  autoDiscovered?: boolean;
  /** Caveat shown to the user and written as a comment. */
  note?: string;
  /**
   * Test files that are run one by one as scripts (`python test_x.py`) instead
   * of with pytest. `commands` is derived from `files`; `tf init --check`
   * narrows `files` to the ones that pass here and records the rest.
   */
  scriptTests?: { dir: string; python: string; files: string[]; excluded?: Array<{ file: string; why: string }> };
}

export interface ProjectSetup {
  stacks: DetectedStack[];
  /** Existing gitignored dependency directories to link into every worktree. */
  worktreeLinks: string[];
}

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'docs']);

function exists(...parts: string[]): boolean {
  return fs.existsSync(path.join(...parts));
}

function topLevelDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function findVenv(dir: string): string | undefined {
  for (const name of ['.venv', 'venv']) {
    if (exists(dir, name, 'bin', 'python')) return name;
  }
  return undefined;
}

function hasPythonTests(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some((name) => /^test_.*\.py$/.test(name) || name === 'tests' || name === 'conftest.py');
  } catch {
    return false;
  }
}

const SCRIPT_MARKER = /if\s+__name__\s*==\s*['"]__main__['"]|^\s*asyncio\.run\(/m;

/** Test files at the top of `dir` that are meant to be run directly as scripts. */
function listScriptStyleTests(dir: string): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => /^test_.*\.py$/.test(name)).sort();
  } catch {
    return [];
  }
  if (files.length === 0) return [];
  const scripts = files.filter((name) => {
    try {
      return SCRIPT_MARKER.test(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      return false;
    }
  });
  // Script style only when most files are scripts: a mixed pytest project with
  // one script is still a pytest project.
  return scripts.length / files.length >= 0.6 ? scripts : [];
}

/** Runs each file in turn with the given interpreter and stops at the first failure. */
export function scriptLoopCommand(rel: string, python: string, files: string[]): string {
  const wrapped: string[] = [];
  let line = '';
  for (const file of files) {
    if ((line + ' ' + file).length > 68 && line) {
      wrapped.push(line);
      line = file;
    } else {
      line = line ? `${line} ${file}` : file;
    }
  }
  if (line) wrapped.push(line);
  return [
    `${rel ? `cd ${rel} && ` : ''}for f in \\`,
    ...wrapped.map((l, i) => `  ${l}${i === wrapped.length - 1 ? '; do' : ' \\'}`),
    `  ${python} "$f" || { echo "FAILED: $f"; exit 1; }`,
    'done',
  ].join('\n');
}

function pythonStack(root: string, rel: string): { stack: DetectedStack; venvLink?: string } | undefined {
  const dir = rel ? path.join(root, rel) : root;
  const marker = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'requirements.txt'].some((f) =>
    exists(dir, f),
  );
  if (!marker || !hasPythonTests(dir)) return undefined;

  const venv = findVenv(dir);
  const python = venv ? `${venv}/bin/python` : 'python3';

  const scripts = listScriptStyleTests(dir);
  if (scripts.length > 0) {
    return {
      stack: {
        label: `Python (test scripts run one by one) in ${rel ? rel + '/' : './'}`,
        commands: [scriptLoopCommand(rel, python, scripts)],
        scriptTests: { dir: rel, python, files: scripts },
        note:
          'These tests run as scripts (python test_x.py), not with pytest. The list includes every script; ' +
          'some may need services (database, server, audio). Run `tf init --check` to keep only the ones that pass here.',
      },
      venvLink: venv ? (rel ? `${rel}/${venv}` : venv) : undefined,
    };
  }

  const command = `${rel ? `cd ${rel} && ` : ''}${python} -m pytest -q`;
  return {
    stack: {
      label: `Python (pytest)${rel ? ` in ${rel}/` : ''}`,
      commands: [command],
      note:
        'Assumes pytest-style tests. Some projects run test files as scripts (python test_x.py); ' +
        'run the command once to make sure it works before relying on it.',
    },
    venvLink: venv ? (rel ? `${rel}/${venv}` : venv) : undefined,
  };
}

function nodeStack(dir: string, rel: string): DetectedStack | undefined {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {}) as Record<string, string>;
    const found = ['test', 'lint', 'typecheck'].filter((s) => scripts[s]);
    if (found.length === 0) return undefined;
    return {
      label: `Node${rel ? ` in ${rel}/` : ''} (scripts: ${found.join(', ')})`,
      commands: [],
      // TaskForge discovers root package.json scripts itself; a sub-project's
      // scripts are not discovered, so those need an explicit command.
      autoDiscovered: rel === '',
    };
  } catch {
    return undefined;
  }
}

export function detectProjectSetup(repoRoot: string): ProjectSetup {
  const stacks: DetectedStack[] = [];
  const links = new Set<string>();

  const root = nodeStack(repoRoot, '');
  if (root) stacks.push(root);

  const py = pythonStack(repoRoot, '');
  if (py) {
    stacks.push(py.stack);
    if (py.venvLink) links.add(py.venvLink);
  }

  if (exists(repoRoot, 'go.mod')) stacks.push({ label: 'Go', commands: ['go test ./...'] });
  if (exists(repoRoot, 'Cargo.toml')) stacks.push({ label: 'Rust', commands: ['cargo test'] });
  if (exists(repoRoot, 'Package.swift')) stacks.push({ label: 'Swift package', commands: ['swift test'] });

  try {
    if (/^test:/m.test(fs.readFileSync(path.join(repoRoot, 'Makefile'), 'utf8')) && stacks.length === 0) {
      stacks.push({ label: 'Makefile (test target)', commands: ['make test'] });
    }
  } catch {
    // no Makefile
  }

  for (const dir of topLevelDirs(repoRoot)) {
    const sub = path.join(repoRoot, dir);
    const subPy = pythonStack(repoRoot, dir);
    if (subPy) {
      stacks.push(subPy.stack);
      if (subPy.venvLink) links.add(subPy.venvLink);
    }
    const subNode = nodeStack(sub, dir);
    if (subNode) {
      stacks.push({ ...subNode, commands: [`cd ${dir} && npm test`], note: 'Sub-project: adjust the package manager if it is not npm.' });
    }
  }

  if (exists(repoRoot, 'node_modules') || stacks.some((s) => s.label.startsWith('Node'))) links.add('node_modules');

  return { stacks, worktreeLinks: [...links] };
}

function yamlString(value: string): string {
  // JSON strings are valid YAML double-quoted scalars.
  return JSON.stringify(value);
}

/** Renders the proposed config file, with comments explaining every choice. */
export function renderProjectConfig(setup: ProjectSetup): string {
  const lines: string[] = [
    '# TaskForge project configuration (optional).',
    '# Without this file TaskForge uses its defaults; it only matters for settings',
    '# the defaults cannot know, mainly how to verify a code change.',
    '# Generated by `tf init`: review it, edit freely, delete what you do not need.',
    '',
  ];

  if (setup.stacks.length > 0) {
    lines.push('# Detected: ' + setup.stacks.map((s) => s.label).join('; '));
    lines.push('');
  }

  if (setup.worktreeLinks.length > 0) {
    lines.push(
      'execution:',
      '  # Every task runs in a fresh git worktree, which has none of your gitignored',
      '  # files. These directories are linked from this checkout into each worktree',
      '  # so verification can use the installed dependencies.',
      '  worktreeLinks:',
      ...setup.worktreeLinks.map((l) => `    - ${yamlString(l)}`),
      '',
    );
  }

  const commands = setup.stacks.flatMap((s) => s.commands);
  const discovered = setup.stacks.filter((s) => s.autoDiscovered);
  if (commands.length > 0) {
    lines.push(
      'verification:',
      '  # Commands that decide whether a code change is correct. A task that changes',
      '  # code is BLOCKED if there is nothing to verify it with. Documentation-only',
      '  # changes do not need them.',
      '  commands:',
      ...commands.flatMap((c) =>
        c.includes('\n')
          ? ['    - |', ...c.split('\n').map((l) => `      ${l}`)]
          : [`    - ${yamlString(c)}`],
      ),
    );
    for (const stack of setup.stacks.filter((s) => s.note)) {
      lines.push(`  # ${stack.label}: ${stack.note}`);
    }
    for (const stack of setup.stacks) {
      const excluded = stack.scriptTests?.excluded ?? [];
      if (excluded.length > 0) {
        lines.push(
          '  # Left out because they did not pass when this file was generated (usually they need',
          '  # a running service, a database, audio input or manual setup). Add them back if they should run:',
          ...excluded.map((e) => `  #   ${e.file} - ${e.why}`),
        );
      }
    }
    lines.push('');
  } else {
    // Keep the key commented out: an empty `verification:` is null, which the
    // config schema rejects.
    lines.push(
      discovered.length > 0
        ? '# Nothing to add: TaskForge already finds your package.json test/lint/typecheck scripts.'
        : '# No test setup was detected. Add the command that checks this project, e.g.:',
      '# verification:',
      '#   commands:',
      '#     - "make test"',
      '',
    );
  }
  lines.push(
    '# Per-folder checks (the most specific matching scope wins):',
    '# verification:',
    '#   scopedCommands:',
    '#     - scope: "ios/**"',
    '#       commands:',
    '#         - "xcodebuild -scheme App -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build"',
    '',
  );
  return lines.join('\n');
}

export function projectConfigPath(repoRoot: string): string {
  return path.join(repoRoot, PROJECT_CONFIG_RELATIVE_PATH);
}

export function hasProjectConfig(repoRoot: string): boolean {
  return fs.existsSync(projectConfigPath(repoRoot));
}

/** Writes the config. Refuses to overwrite an existing file unless `force`. */
export function writeProjectConfig(repoRoot: string, content: string, force = false): string {
  const target = projectConfigPath(repoRoot);
  if (fs.existsSync(target) && !force) {
    throw new Error(`${PROJECT_CONFIG_RELATIVE_PATH} already exists (use --force to overwrite).`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

/** Whether the one-time "this project has no config" notice should be shown. */
export function shouldShowConfigHint(repoRoot: string): boolean {
  if (process.env.TASKFORGE_NO_HINTS === '1' || hasProjectConfig(repoRoot)) return false;
  try {
    const hints = JSON.parse(fs.readFileSync(path.join(repoRoot, HINTS_RELATIVE_PATH), 'utf8'));
    return hints.configHintShown !== true;
  } catch {
    return true;
  }
}

export function markConfigHintShown(repoRoot: string): void {
  try {
    const file = path.join(repoRoot, HINTS_RELATIVE_PATH);
    let hints: Record<string, unknown> = {};
    try {
      hints = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // first hint
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...hints, configHintShown: true }, null, 2) + '\n');
  } catch {
    // never let a hint break startup
  }
}
