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
} from '../src/project-setup.js';

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
