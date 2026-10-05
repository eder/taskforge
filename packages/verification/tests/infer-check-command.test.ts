import { describe, expect, it } from 'vitest';
import { inferCheckCommand, type ProjectTree } from '../src/infer-check-command.js';

const tree = (files: Record<string, string>): ProjectTree => ({
  files: Object.keys(files),
  read: (path) => files[path],
});

describe('inferCheckCommand', () => {
  it('runs pytest in a throwaway environment for a Python project with requirements', () => {
    const found = inferCheckCommand(
      tree({ 'requirements.txt': 'fastapi\nuvicorn\n', 'tests/test_api.py': '', 'app/main.py': '' }),
    );
    expect(found?.command).toBe(
      'python3 -m venv .venv && .venv/bin/python -m pip install -q -r requirements.txt pytest && .venv/bin/python -m pytest -q',
    );
  });

  it('installs the package itself when the project only has a pyproject', () => {
    const found = inferCheckCommand(tree({ 'pyproject.toml': '[tool.pytest.ini_options]', 'tests/api_test.py': '' }));
    expect(found?.command).toContain('pip install -q -e . pytest');
  });

  it('runs pytest directly when there is nothing to install', () => {
    expect(inferCheckCommand(tree({ 'test_a.py': '' }))?.command).toBe('python3 -m pytest -q');
  });

  it('does not guess for Node projects (their scripts are discovered) or unknown ones', () => {
    expect(inferCheckCommand(tree({ 'package.json': '{}', 'tests/test_a.py': '' }))).toBeUndefined();
    expect(inferCheckCommand(tree({ 'README.md': '' }))).toBeUndefined();
  });

  it('recognises other toolchains and a Makefile test target', () => {
    expect(inferCheckCommand(tree({ 'go.mod': '' }))?.command).toBe('go test ./...');
    expect(inferCheckCommand(tree({ 'Cargo.toml': '' }))?.command).toBe('cargo test');
    expect(inferCheckCommand(tree({ Makefile: 'build:\n\tx\ntest:\n\ty\n' }))?.command).toBe('make test');
    expect(inferCheckCommand(tree({ Makefile: 'build:\n\tx\n' }))).toBeUndefined();
  });
});
