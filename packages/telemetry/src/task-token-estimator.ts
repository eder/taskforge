import { Task } from '@taskforge/core';
import { RepositoryProfile } from '@taskforge/shared';

export interface TaskTokenEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  totalEstimatedTokens: number;
  complexity: 'lightweight' | 'standard' | 'heavy';
}

export class TaskTokenEstimator {
  /**
   * Estimates token demands for a task based on its contract, objective, and repository profile.
   */
  static estimateTask(task: Task, _profile?: RepositoryProfile): TaskTokenEstimate {
    const text = `${task.title} ${task.description} ${task.contract?.objective || ''}`;
    const baseTokens = Math.max(200, Math.ceil(text.length / 3.5));

    let contextMultiplier = 2;
    let expectedOutputTokens = 1200;
    let complexity: 'lightweight' | 'standard' | 'heavy' = 'standard';

    const descLower = (task.description + ' ' + task.title).toLowerCase();

    if (
      descLower.includes('readme') ||
      descLower.includes('docs') ||
      descLower.includes('documenta') ||
      descLower.includes('typo') ||
      descLower.includes('translate') ||
      descLower.includes('traduz')
    ) {
      complexity = 'lightweight';
      contextMultiplier = 1.2;
      expectedOutputTokens = 600;
    } else if (task.type === 'investigation') {
      complexity = 'standard';
      contextMultiplier = 3.5;
      expectedOutputTokens = 2000;
    } else if (task.type === 'review') {
      complexity = 'lightweight';
      contextMultiplier = 2.0;
      expectedOutputTokens = 1000;
    } else if (task.type === 'implementation') {
      if (
        descLower.includes('refactor') ||
        descLower.includes('migration') ||
        descLower.includes('rewrite')
      ) {
        complexity = 'heavy';
        contextMultiplier = 6.0;
        expectedOutputTokens = 4000;
      } else {
        complexity = 'standard';
        contextMultiplier = 3.0;
        expectedOutputTokens = 2500;
      }
    }

    const estimatedInputTokens = Math.round(baseTokens * contextMultiplier + 500);
    const estimatedOutputTokens = expectedOutputTokens;
    const totalEstimatedTokens = estimatedInputTokens + estimatedOutputTokens;

    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      totalEstimatedTokens,
      complexity,
    };
  }
}
