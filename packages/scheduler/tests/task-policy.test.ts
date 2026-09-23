import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '@taskforge/shared';
import { Task } from '@taskforge/core';
import { allowedWritersForTask, verificationCommandsForTask } from '../src/task-policy.js';

function task(scope: string[]): Task {
  return {
    id: 'TASK-01',
    goalId: 'goal-1',
    title: 'Scoped task',
    description: 'Scoped task',
    type: 'implementation',
    status: 'ready',
    dependencies: [],
    contract: {
      objective: 'Change scoped code',
      allowedScope: scope,
      forbiddenChanges: [],
      acceptanceCriteria: ['Done'],
      dependencies: [],
      completionMode: 'mutation',
    },
    acceptanceCriteria: ['Done'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('task policy', () => {
  it('restricts writers using the most-specific matching scope', () => {
    const config = getDefaultConfig();
    config.ownership.rules = [
      { scope: '*', writers: ['claude', 'codex', 'agy'] },
      { scope: 'ios/**', writers: ['codex'] },
    ];

    expect([...allowedWritersForTask(task(['ios/**']), config)!]).toEqual(['codex']);
  });

  it('does not infer narrow ownership for an unresolved repository-wide scope', () => {
    const config = getDefaultConfig();
    config.ownership.rules = [{ scope: 'ios/**', writers: ['codex'] }];

    expect(allowedWritersForTask(task(['*']), config)).toBeUndefined();
  });

  it('returns an empty writer set when multiple task scopes have conflicting ownership', () => {
    const config = getDefaultConfig();
    config.ownership.rules = [
      { scope: 'ios/**', writers: ['codex'] },
      { scope: 'server/**', writers: ['claude'] },
    ];

    expect([...allowedWritersForTask(task(['ios/**', 'server/**']), config)!]).toEqual([]);
  });

  it('returns scoped verification commands for matching task scope', () => {
    const config = getDefaultConfig();
    config.verification.commands = ['git diff --check'];
    config.verification.scopedCommands = [
      { scope: 'ios/**', commands: ['swiftc -parse ios/ZairaCompanion/*.swift'] },
    ];

    expect(verificationCommandsForTask(task(['ios/**']), config)).toEqual([
      'git diff --check',
      'swiftc -parse ios/ZairaCompanion/*.swift',
    ]);
  });
});
