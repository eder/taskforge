import { describe, expect, it } from 'vitest';
import type { Task } from '@taskforge/core';
import { ExecutionUsageEstimator } from '../src/execution-usage-estimator.js';

function task(
  id: string,
  type: Task['type'],
  title: string,
  description = title,
): Task {
  return {
    id,
    goalId: 'goal-usage',
    title,
    description,
    type,
    status: 'proposed',
    dependencies: [],
    contract: {
      objective: description,
      allowedScope: ['**'],
      forbiddenChanges: [],
      acceptanceCriteria: ['Complete the requested work'],
      dependencies: [],
    },
    acceptanceCriteria: ['Complete the requested work'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('ExecutionUsageEstimator', () => {
  it('returns ranges instead of a single precise token count', () => {
    const estimate = ExecutionUsageEstimator.estimateRun({
      tasks: [task('TASK-1', 'implementation', 'Implement provider abstraction')],
      originalUserRequest: 'Create a provider-neutral LLM abstraction.',
    });

    expect(estimate.minTokens).toBeGreaterThan(0);
    expect(estimate.expectedTokens).toBeGreaterThan(estimate.minTokens);
    expect(estimate.maxTokens).toBeGreaterThan(estimate.expectedTokens);
    expect(estimate.confidence).toBe('low');
    expect(estimate.baselineAssignments).toBe(1);
  });

  it('counts the original user request once per baseline assignment', () => {
    const longRequest = 'provider architecture requirement '.repeat(500);
    const oneAssignment = ExecutionUsageEstimator.estimateRun({
      tasks: [task('TASK-1', 'investigation', 'Inspect current planner and router')],
      originalUserRequest: longRequest,
      assignmentCounts: { 'TASK-1': 1 },
    });
    const threeAssignments = ExecutionUsageEstimator.estimateRun({
      tasks: [task('TASK-1', 'investigation', 'Inspect current planner and router')],
      originalUserRequest: longRequest,
      assignmentCounts: { 'TASK-1': 3 },
    });

    expect(threeAssignments.baselineAssignments).toBe(3);
    expect(threeAssignments.expectedTokens).toBe(oneAssignment.expectedTokens * 3);
    expect(threeAssignments.breakdown[0].assignmentCount).toBe(3);
    expect(threeAssignments.breakdown[0].estimatedPromptTokensPerAssignment).toBeGreaterThan(3000);
  });

  it('uses planner collaboration metadata when routing count is not supplied', () => {
    const collaborative = task('TASK-1', 'architecture', 'Design provider abstraction');
    collaborative.contract.metadata = {
      recommendCollaboration: true,
      collaboration: {
        reason: 'Need implementation and architecture review',
        requestedRoles: ['implementer', 'architecture_reviewer'],
      },
    };

    const estimate = ExecutionUsageEstimator.estimateRun({
      tasks: [collaborative],
      originalUserRequest: 'Design the architecture.',
    });

    expect(estimate.baselineAssignments).toBe(2);
    expect(estimate.breakdown[0].assignmentCount).toBe(2);
    expect(estimate.confidence).toBe('medium');
  });

  it('makes repository-heavy work materially larger than documentation work', () => {
    const docs = ExecutionUsageEstimator.estimateRun({
      tasks: [task('TASK-DOCS', 'implementation', 'Update README documentation')],
      originalUserRequest: 'Document provider configuration.',
    });
    const refactor = ExecutionUsageEstimator.estimateRun({
      tasks: [
        task(
          'TASK-REFACTOR',
          'refactoring',
          'Refactor Planner and Router provider architecture',
        ),
      ],
      originalUserRequest: 'Make Planner and Router provider-neutral.',
    });

    expect(refactor.expectedTokens).toBeGreaterThan(docs.expectedTokens);
    expect(refactor.maxTokens).toBeGreaterThan(docs.maxTokens);
    expect(refactor.breakdown[0].complexity).toBe('heavy');
    expect(docs.breakdown[0].complexity).toBe('lightweight');
  });

  it('applies historical observed-vs-estimated calibration to future ranges', () => {
    const target = task('TASK-1', 'implementation', 'Implement provider abstraction');

    const uncalibrated = ExecutionUsageEstimator.estimateRun({
      tasks: [target],
      originalUserRequest: 'Create provider abstraction.',
      assignmentCounts: { 'TASK-1': 1 },
    });

    const calibrated = ExecutionUsageEstimator.estimateRun({
      tasks: [target],
      originalUserRequest: 'Create provider abstraction.',
      assignmentCounts: { 'TASK-1': 1 },
      calibrationByTaskType: {
        implementation: {
          taskType: 'implementation',
          sampleSize: 12,
          p25Ratio: 1.2,
          medianRatio: 1.5,
          p75Ratio: 1.8,
          confidence: 'high',
        },
      },
    });

    expect(calibrated.expectedTokens).toBeGreaterThan(uncalibrated.expectedTokens);
    expect(calibrated.minTokens).toBeGreaterThanOrEqual(uncalibrated.minTokens);
    expect(calibrated.maxTokens).toBeGreaterThan(uncalibrated.maxTokens);
    expect(calibrated.confidence).toBe('high');
    expect(calibrated.assumptions.join(' ')).toContain('Historical calibration applied');
  });

  it('documents sources of uncertainty instead of hiding them', () => {
    const estimate = ExecutionUsageEstimator.estimateRun({
      tasks: [task('TASK-1', 'testing', 'Test all providers')],
      originalUserRequest: 'Test OpenAI, Anthropic and Gemini.',
    });

    expect(estimate.assumptions.join(' ')).toContain('Retries');
    expect(estimate.assumptions.join(' ')).toContain('provider-hidden');
    expect(estimate.assumptions.join(' ')).toContain('one baseline assignment');
  });
});
