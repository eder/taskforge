import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectInstructionResolver } from '../src/project-instructions.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-instructions-'));
  roots.push(root);
  return root;
}

describe('ProjectInstructionResolver', () => {
  it('loads root instructions and markdown documents they reference', () => {
    const root = repo();
    fs.mkdirSync(path.join(root, 'ios'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Read ios/CAPABILITIES.md before changing the app.');
    fs.writeFileSync(path.join(root, 'ios/CAPABILITIES.md'), '# Contracts\nDo not invent endpoints.');

    const set = new ProjectInstructionResolver(root).resolve(['*']);

    expect(set.documents.map((doc) => doc.path)).toContain('AGENTS.md');
    expect(set.documents.map((doc) => doc.path)).toContain('ios/CAPABILITIES.md');
  });

  it('loads nested instruction entry points during repository planning', () => {
    const root = repo();
    fs.mkdirSync(path.join(root, 'ios'));
    fs.writeFileSync(path.join(root, 'ios/AGENTS.md'), 'Only Codex may edit this directory.');

    const set = new ProjectInstructionResolver(root).resolve(['*']);

    expect(set.documents.map((doc) => doc.path)).toContain('ios/AGENTS.md');
  });

  it('does not follow markdown references outside the repository', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Read ../SECRET.md.');

    const set = new ProjectInstructionResolver(root).resolve(['*']);

    expect(set.documents).toHaveLength(1);
    expect(set.documents[0].path).toBe('AGENTS.md');
  });
});
