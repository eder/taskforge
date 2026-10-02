import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../src/agent-registry.js';
import {
  AiderAdapter,
  CursorAdapter,
  GooseAdapter,
  OpenCodeAdapter,
} from '../src/extended-adapters.js';

describe('extended adapters', () => {
  it('build non-interactive command lines with the prompt last', () => {
    expect(new CursorAdapter()['formatArgs']('do it')).toEqual([
      '--output-format',
      'stream-json',
      '--force',
      '-p',
      'do it',
    ]);
    const aider = new AiderAdapter()['formatArgs']('do it');
    expect(aider.slice(-2)).toEqual(['--message', 'do it']);
    expect(aider).toContain('--no-auto-commits');
    expect(new OpenCodeAdapter()['formatArgs']('do it')).toEqual(['run', 'do it']);
    expect(new GooseAdapter()['formatArgs']('do it')).toEqual(['run', '--no-session', '-t', 'do it']);
  });

  it('expose binary names and provider-native, non-interactive capabilities', async () => {
    const cases: Array<[{ id: string; commandBinary: string }, string, string]> = [
      [new CursorAdapter(), 'cursor', 'cursor-agent'],
      [new AiderAdapter(), 'aider', 'aider'],
      [new OpenCodeAdapter(), 'opencode', 'opencode'],
      [new GooseAdapter(), 'goose', 'goose'],
    ];
    for (const [adapter, id, binary] of cases) {
      expect(adapter.id).toBe(id);
      expect(adapter.commandBinary).toBe(binary);
    }
    const caps = await new AiderAdapter().capabilities();
    expect(caps.stdinMode).toBe('close_after_spawn');
    expect(caps.permissionProtocol).toBe('provider_native');
    expect(caps.questionProtocol).toBe('unsupported');
  });

  it('honor command and args overrides', () => {
    const adapter = new AiderAdapter({ binaryPath: '/opt/aider', defaultArgs: ['--message'] });
    expect(adapter.commandBinary).toBe('/opt/aider');
    expect(adapter['formatArgs']('x')).toEqual(['--message', 'x']);
  });
});

describe('AgentRegistry harness registration', () => {
  it('registers only the built-in harnesses by default', () => {
    const ids = new AgentRegistry(true).list().map((a) => a.id);
    expect(ids).toEqual(['claude', 'codex', 'agy']);
  });

  it('registers extended harnesses only when configured', () => {
    const registry = new AgentRegistry(true, {
      cursor: { enabled: true },
      aider: { enabled: true, command: '/opt/aider' },
    });
    const ids = registry.list().map((a) => a.id);
    expect(ids).toEqual(['claude', 'codex', 'agy', 'cursor', 'aider']);
    expect(registry.get('aider')).toBeDefined();
    expect(registry.get('goose')).toBeUndefined();
  });

  it('skips harnesses explicitly disabled in config', () => {
    const registry = new AgentRegistry(true, { codex: { enabled: false }, cursor: { enabled: false } });
    expect(registry.list().map((a) => a.id)).toEqual(['claude', 'agy']);
  });
});
