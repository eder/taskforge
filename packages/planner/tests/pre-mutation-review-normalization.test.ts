import { describe, expect, it } from 'vitest';
import { TaskGraphValidator } from '../src/task-graph-validator.js';

describe('TaskGraphValidator pre-implementation review task normalization', () => {
  it('converts upfront review tasks without mutating prerequisites into investigation/report tasks', () => {
    const res = TaskGraphValidator.validate({
      tasks: [
        {
          taskId: '1',
          title: 'Analyze and validate existing code',
          description: 'Inspect the repository and find gaps',
          type: 'review',
          dependencies: [],
          objective: 'Analyze existing code before implementing changes',
          acceptanceCriteria: ['Analysis report produced'],
        },
        {
          taskId: '2',
          title: 'Design the new feature',
          description: 'Design architecture for the improvements',
          type: 'review',
          dependencies: ['1'],
          objective: 'Produce design plan',
          acceptanceCriteria: ['Design documented'],
        },
        {
          taskId: '3',
          title: 'Implement improvements',
          description: 'Write code changes',
          type: 'implementation',
          dependencies: ['2'],
          objective: 'Implement the planned improvements',
          allowedScope: ['packages/shared/**'],
          acceptanceCriteria: ['Tests pass'],
        },
        {
          taskId: '4',
          title: 'Review the implementation',
          description: 'Independent code review after implementation',
          type: 'review',
          dependencies: ['3'],
          objective: 'Review the code produced in task 3',
          acceptanceCriteria: ['Implementation approved'],
        },
      ],
    });

    expect(res.valid).toBe(true);
    const graph = res.graph!;
    expect(graph.getTask('1')?.type).toBe('investigation');
    expect(graph.getTask('1')?.contract.completionMode).toBe('report');
    expect(graph.getTask('2')?.type).toBe('investigation');
    expect(graph.getTask('2')?.contract.completionMode).toBe('report');
    // Post-implementation review stays a strict review gate
    expect(graph.getTask('4')?.type).toBe('review');
    expect(graph.getTask('4')?.contract.completionMode).toBe('review');
  });

  it('preserves review tasks untouched in pure read-only review plans without mutating tasks', () => {
    const res = TaskGraphValidator.validate({
      tasks: [
        {
          taskId: '1',
          title: 'Review pull request changes',
          description: 'Audit PR diff for bugs and security issues',
          type: 'review',
          dependencies: [],
          objective: 'Provide formal review verdict on the PR',
          acceptanceCriteria: ['Review findings reported'],
        },
      ],
    });

    expect(res.valid).toBe(true);
    expect(res.graph!.getTask('1')?.type).toBe('review');
    expect(res.graph!.getTask('1')?.contract.completionMode).toBe('review');
  });
});
