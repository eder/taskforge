import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  diagnoseEnvironmentFailure,
  findIgnoredDotenvFiles,
  findComposeServiceForPort,
  refusedPort,
  applyEnvironmentFixes,
  describeFix,
  actionableFixes,
} from '../src/environment-repair.js';

// Output of a real run: the isolated copy had no .env and the database was down.
const REAL_OUTPUT = `Check 'explicit-1' failed with exit code 2
ERROR test_uploads.py - RuntimeError: no LLM api_key configured
ERROR test_wake_button.py - OSError: Multiple exceptions: [Errno 61] Connect call failed ('127.0.0.1', 5432)
!!!!!!!!!!!!!!!!!!! Interrupted: 35 errors during collection !!!!!!!!!!!!!!!!!!!`;

describe('environment repair', () => {
  let repo: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-envrepair-'));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@t.dev');
    run('config', 'user.name', 'T');
    write('.gitignore', '.env\n.env.*\n!.env.example\nnode_modules/\n.venv/\n');
    write('server/app.py', 'print(1)\n');
    write('server/.env', 'LLM_API_KEY=secret\nDATABASE_URL=postgres://x\n');
    write('server/.env.example', 'LLM_API_KEY=\n');
    write('node_modules/pkg/.env', 'IGNORED=1\n');
    write(
      'docker-compose.yml',
      ['services:', '  memory-postgres:', '    image: pgvector/pgvector:pg16', '    ports:', '      - "127.0.0.1:5432:5432"', '  redis:', '    image: redis', '    ports:', '      - "6379:6379"'].join('\n'),
    );
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('finds the gitignored .env that exists for the developer, and not templates or vendored ones', () => {
    expect(findIgnoredDotenvFiles(repo)).toEqual(['server/.env']);
  });

  it('reads the port a refused connection was trying to reach, and the compose service that publishes it', () => {
    expect(refusedPort(REAL_OUTPUT)).toBe(5432);
    expect(refusedPort('failed to connect to localhost:6379')).toBe(6379);
    expect(findComposeServiceForPort(repo, 5432)).toEqual({ service: 'memory-postgres', file: 'docker-compose.yml' });
    expect(findComposeServiceForPort(repo, 6379)?.service).toBe('redis');
    expect(findComposeServiceForPort(repo, 9999)).toBeUndefined();
  });

  it('diagnoses the real failure: link the .env and start the database, with the exact command', () => {
    const fixes = diagnoseEnvironmentFailure({ repoRoot: repo, text: REAL_OUTPUT, env: {} });
    expect(fixes).toEqual([
      { kind: 'link_files', paths: ['server/.env'] },
      {
        kind: 'start_service',
        service: 'memory-postgres',
        port: 5432,
        file: 'docker-compose.yml',
        command: 'docker compose -f docker-compose.yml up -d memory-postgres',
      },
    ]);
    expect(describeFix(fixes[0])).toContain('server/.env');
    expect(describeFix(fixes[1])).toContain('memory-postgres');
  });

  it('offers pass_env only for a secret the failure names and the person actually has, when no .env exists', () => {
    fs.rmSync(path.join(repo, 'server/.env'));
    const text = 'KeyError: STRIPE_API_KEY is not set';
    expect(diagnoseEnvironmentFailure({ repoRoot: repo, text, env: {} })).toEqual([]);
    expect(diagnoseEnvironmentFailure({ repoRoot: repo, text, env: { STRIPE_API_KEY: 'x' } })).toEqual([
      { kind: 'pass_env', names: ['STRIPE_API_KEY'] },
    ]);
  });

  it('says so when nothing can be done automatically', () => {
    const fixes = diagnoseEnvironmentFailure({ repoRoot: repo, text: 'connection refused 127.0.0.1:7777', env: {} });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].kind).toBe('manual');
    expect(actionableFixes(fixes)).toEqual([]);
  });

  it('applies the link: writes the defaults plus the file, keeps comments, and is idempotent', async () => {
    write('.taskforge/config.yaml', '# my comment\nverification:\n  tests: true\n');
    const first = await applyEnvironmentFixes(repo, [{ kind: 'link_files', paths: ['server/.env'] }]);
    expect(first.failed).toEqual([]);
    expect(first.linksAdded).toEqual(['server/.env']);
    const text = fs.readFileSync(path.join(repo, '.taskforge/config.yaml'), 'utf8');
    expect(text).toContain('# my comment');
    expect(text).toContain('server/.env');
    expect(text).toContain('node_modules'); // the defaults were kept, not replaced
    const second = await applyEnvironmentFixes(repo, [{ kind: 'link_files', paths: ['server/.env'] }]);
    expect(second.applied[0]).toContain('already linked');
    expect(fs.readFileSync(path.join(repo, '.taskforge/config.yaml'), 'utf8').match(/server\/\.env/g)).toHaveLength(1);
  });

  it('applies pass_env into a config that does not exist yet', async () => {
    const result = await applyEnvironmentFixes(repo, [{ kind: 'pass_env', names: ['LLM_API_KEY'] }]);
    expect(result.envAdded).toEqual(['LLM_API_KEY']);
    expect(fs.readFileSync(path.join(repo, '.taskforge/config.yaml'), 'utf8')).toContain('LLM_API_KEY');
  });
});
