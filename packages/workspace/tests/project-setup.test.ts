import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '@taskforge/shared';
import {
  detectProjectSetup,
  renderProjectConfig,
  writeProjectConfig,
  hasProjectConfig,
  shouldShowConfigHint,
  markConfigHintShown,
  scriptLoopCommand,
} from '../src/project-setup.js';
import { calibrateScriptTests } from '../src/project-check.js';

describe('project setup detection', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-setup-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, content = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };

  it('treats a Node project as auto-discovered and writes no commands', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }));
    const setup = detectProjectSetup(root);
    expect(setup.stacks[0].autoDiscovered).toBe(true);
    expect(setup.stacks.flatMap((s) => s.commands)).toEqual([]);
    expect(renderProjectConfig(setup)).toContain('already finds your package.json');
    writeProjectConfig(root, renderProjectConfig(setup));
    expect(() => loadConfig(path.join(root, '.taskforge/config.yaml'))).not.toThrow();
  });

  it('detects Python in a sub-directory with its venv, and links the venv into worktrees', () => {
    write('server/requirements.txt', 'pytest\n');
    write('server/test_a.py', 'def test_a(): pass\n');
    write('server/.venv/bin/python', '');
    const setup = detectProjectSetup(root);
    expect(setup.stacks.flatMap((s) => s.commands)).toEqual(['cd server && .venv/bin/python -m pytest -q']);
    expect(setup.worktreeLinks).toContain('server/.venv');
  });

  it('falls back to python3 when there is no venv, and to go/cargo/swift by marker files', () => {
    write('pyproject.toml', '[project]\n');
    write('tests/test_x.py', '');
    write('go.mod', 'module x\n');
    write('Cargo.toml', '[package]\n');
    write('Package.swift', '// swift\n');
    const commands = detectProjectSetup(root).stacks.flatMap((s) => s.commands);
    expect(commands).toEqual(
      expect.arrayContaining(['python3 -m pytest -q', 'go test ./...', 'cargo test', 'swift test']),
    );
  });

  it('detects nothing in an empty project and renders commented examples only', () => {
    const setup = detectProjectSetup(root);
    expect(setup.stacks).toEqual([]);
    const text = renderProjectConfig(setup);
    expect(text).toContain('No test setup was detected');
    // The generated file must be accepted by TaskForge's own config loader.
    const file = path.join(root, '.taskforge/config.yaml');
    writeProjectConfig(root, text);
    expect(loadConfig(file).verification.commands).toEqual([]);
  });

  it('renders valid YAML whose commands round-trip exactly (quotes, && and pipes)', () => {
    const text = renderProjectConfig({
      stacks: [{ label: 'x', commands: ['cd a && python -m pytest -q "tests dir" | tee out'] }],
      worktreeLinks: ['server/.venv'],
    });
    writeProjectConfig(root, text);
    const config = loadConfig(path.join(root, '.taskforge/config.yaml'));
    expect(config.verification.commands).toEqual(['cd a && python -m pytest -q "tests dir" | tee out']);
    expect(config.execution.worktreeLinks).toEqual(['server/.venv']);
  });
});

describe('writing the config and the one-time hint', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-setup-write-'));
    delete process.env.TASKFORGE_NO_HINTS;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('never overwrites an existing config unless forced', () => {
    writeProjectConfig(root, 'a: 1\n');
    expect(hasProjectConfig(root)).toBe(true);
    expect(() => writeProjectConfig(root, 'b: 2\n')).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(root, '.taskforge/config.yaml'), 'utf8')).toBe('a: 1\n');
    writeProjectConfig(root, 'b: 2\n', true);
    expect(fs.readFileSync(path.join(root, '.taskforge/config.yaml'), 'utf8')).toBe('b: 2\n');
  });

  it('shows the hint once when there is no config, never when there is one or when disabled', () => {
    expect(shouldShowConfigHint(root)).toBe(true);
    markConfigHintShown(root);
    expect(shouldShowConfigHint(root)).toBe(false);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-setup-hint-'));
    writeProjectConfig(other, 'a: 1\n');
    expect(shouldShowConfigHint(other)).toBe(false);

    process.env.TASKFORGE_NO_HINTS = '1';
    const third = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-setup-hint2-'));
    expect(shouldShowConfigHint(third)).toBe(false);
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(third, { recursive: true, force: true });
  });
});

describe('script-style Python test suites (run as `python test_x.py`)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-setup-scripts-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, content = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };

  it('proposes running each script, not pytest, when most tests are scripts', () => {
    write('server/requirements.txt', 'aiohttp\n');
    write('server/.venv/bin/python', '');
    write('server/test_a.py', 'async def main(): ...\nif __name__ == "__main__":\n    asyncio.run(main())\n');
    write('server/test_b.py', 'def check(): ...\nif __name__ == "__main__":\n    check()\n');
    write('server/test_c.py', 'import asyncio\nasyncio.run(main())\n');

    const stack = detectProjectSetup(root).stacks.find((s) => s.scriptTests);
    expect(stack).toBeDefined();
    expect(stack!.scriptTests!.files).toEqual(['test_a.py', 'test_b.py', 'test_c.py']);
    expect(stack!.commands[0]).toContain('cd server && for f in');
    expect(stack!.commands[0]).toContain('.venv/bin/python "$f" || { echo "FAILED: $f"; exit 1; }');
    expect(stack!.commands[0]).not.toContain('pytest');
  });

  it('keeps pytest for a normal pytest project, even with one script in it', () => {
    write('pyproject.toml', '[tool.pytest.ini_options]\n');
    write('test_a.py', 'def test_a(): pass\n');
    write('test_b.py', 'def test_b(): pass\n');
    write('test_c.py', 'def test_c(): pass\n');
    write('test_script.py', 'if __name__ == "__main__":\n    pass\n');
    const commands = detectProjectSetup(root).stacks.flatMap((s) => s.commands);
    expect(commands).toEqual(['python3 -m pytest -q']);
  });

  it('renders the multi-line loop as valid YAML that TaskForge loads and that round-trips', () => {
    const files = Array.from({ length: 12 }, (_, i) => `test_feature_number_${i}.py`);
    const command = scriptLoopCommand('server', '.venv/bin/python', files);
    const text = renderProjectConfig({
      stacks: [{ label: 'x', commands: [command] }],
      worktreeLinks: [],
    });
    writeProjectConfig(root, text);
    const loaded = loadConfig(path.join(root, '.taskforge/config.yaml'));
    expect(loaded.verification.commands).toHaveLength(1);
    // The loop survives YAML exactly, so the shell receives what we generated.
    expect(loaded.verification.commands[0].trim()).toBe(command.trim());
  });

  it('lists the left-out scripts as comments with the reason', () => {
    const text = renderProjectConfig({
      stacks: [
        {
          label: 'Python scripts',
          commands: [scriptLoopCommand('server', 'python3', ['test_a.py'])],
          scriptTests: {
            dir: 'server',
            python: 'python3',
            files: ['test_a.py'],
            excluded: [{ file: 'test_memory_store.py', why: 'connection refused' }],
          },
        },
      ],
      worktreeLinks: [],
    });
    expect(text).toContain('test_memory_store.py - connection refused');
    writeProjectConfig(root, text);
    expect(() => loadConfig(path.join(root, '.taskforge/config.yaml'))).not.toThrow();
  });
});

describe('calibrateScriptTests', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-calibrate-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps the scripts that pass and records why the others were left out', async () => {
    // A fake interpreter: "runs" a file by looking at its name.
    fs.mkdirSync(path.join(root, 'server'));
    fs.writeFileSync(
      path.join(root, 'server/py.sh'),
      '#!/bin/sh\ncase "$1" in\n  *ok*) exit 0 ;;\n  *slow*) sleep 30 ;;\n  *) echo "ConnectionRefusedError: [Errno 61]" >&2; exit 1 ;;\nesac\n',
      { mode: 0o755 },
    );
    const seen: string[] = [];
    const result = await calibrateScriptTests({
      repoRoot: root,
      dir: 'server',
      python: './py.sh',
      files: ['test_ok_a.py', 'test_db.py', 'test_ok_b.py', 'test_slow.py'],
      timeoutSecondsPerFile: 1,
      onFile: (file, outcome) => seen.push(`${outcome}:${file}`),
    });
    expect(result.passed).toEqual(['test_ok_a.py', 'test_ok_b.py']);
    expect(result.failed.map((f) => f.file)).toEqual(['test_db.py', 'test_slow.py']);
    expect(result.failed[0].why).toContain('ConnectionRefusedError');
    expect(result.failed[1].why).toContain('timed out');
    expect(seen).toHaveLength(4);
  });
});
