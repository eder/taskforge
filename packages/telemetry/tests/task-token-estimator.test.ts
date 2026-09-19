import { describe, it, expect } from 'vitest';
import { TaskTokenEstimator } from '../src/task-token-estimator.js';
import { Task } from '@taskforge/core';

describe('TaskTokenEstimator', () => {
  it('estimates lightweight tokens for documentation/readme tasks', () => {
    const task: Task = {
      id: 'TASK-01',
      goalId: 'goal-1',
      title: 'Documentation and Content Update',
      description: 'Na raiz desse projeto eu preciso mudar o conteudo README.MD para ingles',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Update README in English',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: [],
        dependencies: [],
      },
      acceptanceCriteria: [],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const estimate = TaskTokenEstimator.estimateTask(task);
    expect(estimate.complexity).toBe('lightweight');
    expect(estimate.totalEstimatedTokens).toBeLessThan(3000);
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedOutputTokens).toBeGreaterThan(0);
  });

  it('estimates heavier tokens for complex code refactoring tasks', () => {
    const task: Task = {
      id: 'TASK-02',
      goalId: 'goal-2',
      title: 'Full Database Migration and Architecture Refactor',
      description: 'Perform major refactor and migration from sqlite to postgres',
      type: 'implementation',
      status: 'proposed',
      dependencies: [],
      contract: {
        objective: 'Refactor database architecture',
        allowedScope: ['*'],
        forbiddenChanges: [],
        acceptanceCriteria: [],
        dependencies: [],
      },
      acceptanceCriteria: [],
      reworkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const estimate = TaskTokenEstimator.estimateTask(task);
    expect(estimate.complexity).toBe('heavy');
    expect(estimate.totalEstimatedTokens).toBeGreaterThan(4000);
  });
});
