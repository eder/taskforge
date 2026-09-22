import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskForgeDatabase } from '../src/database.js';
import { AgentAvailabilityRepository } from '../src/repositories/agent-availability-repository.js';

const dbPath = path.resolve(__dirname, 'agent-availability-test.sqlite');

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('AgentAvailabilityRepository', () => {
  it('persists availability across database reopen', () => {
    let db = new TaskForgeDatabase(dbPath);
    let repo = new AgentAvailabilityRepository(db);

    const resetAt = Date.now() + 60_000;
    repo.upsert({
      agentId: 'agy',
      status: 'quota_exhausted',
      reason: 'resets in 1m',
      recordedAt: Date.now(),
      resetAt,
      source: 'runtime',
    });
    db.close();

    db = new TaskForgeDatabase(dbPath);
    repo = new AgentAvailabilityRepository(db);

    const record = repo.get('agy');
    expect(record?.agentId).toBe('agy');
    expect(record?.status).toBe('quota_exhausted');
    expect(record?.reason).toBe('resets in 1m');
    expect(record?.resetAt).toBe(resetAt);
    expect(record?.source).toBe('runtime');

    db.close();
  });

  it('merges active legacy quota state without overwriting newer global state', () => {
    const sourceDb = new TaskForgeDatabase(':memory:');
    const targetDb = new TaskForgeDatabase(':memory:');
    const source = new AgentAvailabilityRepository(sourceDb);
    const target = new AgentAvailabilityRepository(targetDb);
    const now = Date.now();

    source.upsert({
      agentId: 'agy',
      status: 'quota_exhausted',
      reason: 'legacy quota',
      recordedAt: now - 1000,
      resetAt: now + 60_000,
      source: 'runtime',
    });
    source.upsert({
      agentId: 'codex',
      status: 'rate_limited',
      reason: 'expired legacy rate limit',
      recordedAt: now - 2000,
      resetAt: now - 1,
      source: 'runtime',
    });

    target.upsert({
      agentId: 'claude',
      status: 'auth_failed',
      reason: 'new global auth state',
      recordedAt: now,
      source: 'runtime',
    });

    expect(target.mergeFrom(source, now)).toBe(1);
    expect(target.get('agy')?.reason).toBe('legacy quota');
    expect(target.get('codex')).toBeUndefined();
    expect(target.get('claude')?.reason).toBe('new global auth state');

    sourceDb.close();
    targetDb.close();
  });

  it('upserts and deletes one provider without affecting others', () => {
    const db = new TaskForgeDatabase(dbPath);
    const repo = new AgentAvailabilityRepository(db);

    repo.upsert({
      agentId: 'agy',
      status: 'quota_exhausted',
      recordedAt: 1,
      resetAt: 2,
      source: 'runtime',
    });
    repo.upsert({
      agentId: 'codex',
      status: 'rate_limited',
      reason: 'retry in 45s',
      recordedAt: 3,
      resetAt: 4,
      source: 'runtime',
    });

    repo.upsert({
      agentId: 'agy',
      status: 'auth_failed',
      reason: 'session expired',
      recordedAt: 5,
      source: 'runtime',
    });

    expect(repo.get('agy')?.status).toBe('auth_failed');
    expect(repo.list()).toHaveLength(2);

    repo.delete('agy');

    expect(repo.get('agy')).toBeUndefined();
    expect(repo.get('codex')?.status).toBe('rate_limited');

    db.close();
  });
});
