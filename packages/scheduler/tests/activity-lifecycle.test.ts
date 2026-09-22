import { describe, expect, it } from 'vitest';
import { AgentActivityTracker } from '@taskforge/agents';
import { getDefaultConfig, type AgentAssignment } from '@taskforge/shared';
import type { Task } from '@taskforge/core';
import { executeGovernedAssignment } from '../src/governed-assignment.js';

describe('governed assignment activity lifecycle', () => {
  it('retires activity even when setup fails before the agent starts', async () => {
    const activityTracker = new AgentActivityTracker();
    const assignment: AgentAssignment = {
      id: 'asgn-setup-failure',
      taskId: 'TASK-SETUP-FAILURE',
      agentId: 'never-started',
      role: 'researcher',
      objective: 'Inspect repository',
      status: 'pending',
    };
    const task: Task = {
      id: 'TASK-SETUP-FAILURE',
      goalId: 'goal-setup-failure',
      title: 'Inspect repository',
      description: 'Inspect repository',
      type: 'investigation',
      status: 'ready',
      dependencies: [],
      contract: {
        objective: 'Inspect repository',
        allowedScope: [],
        forbiddenChanges: ['*'],
        acceptanceCriteria: ['Return findings'],
        dependencies: [],
      },
      acceptanceCriteria: ['Return findings'],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(
      executeGovernedAssignment({
        runId: 'run-setup-failure',
        baseCommit: 'base-sha',
        repoRoot: '/tmp/taskforge-setup-failure',
        config: getDefaultConfig(),
        task,
        assignment,
        agent: {
          id: 'never-started',
          name: 'Never Started',
          detect: async () => true,
          capabilities: async () => ({
            canRead: true,
            canWrite: false,
            canExecute: false,
            languages: [],
            tools: [],
          }),
          execute: async () => ({
            success: true,
            message: 'should never execute',
            durationMs: 0,
          }),
        },
        worktreeManager: {} as any,
        workspaceRepo: {} as any,
        assignmentRepo: {} as any,
        executionRepo: {} as any,
        eventRepo: {
          append: () => {
            throw new Error('persistence unavailable');
          },
        } as any,
        activityTracker,
      }),
    ).rejects.toThrow('persistence unavailable');

    expect(activityTracker.getActive()).toEqual([]);
  });
});
