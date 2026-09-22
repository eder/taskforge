import { describe, it, expect } from 'vitest';
import { Task } from '@taskforge/core';
import { AgentResult } from '@taskforge/shared';
import {
  CompletionGate,
  resolveCompletionPolicy,
} from '../src/completion-gate.js';

function createTask(
  type: Task['type'],
  overrides?: Partial<Task['contract']> & { id?: string; title?: string; description?: string },
): Task {
  return {
    id: overrides?.id ?? 'TASK-01',
    goalId: 'goal-test',
    title: overrides?.title ?? `${type} task title`,
    description: overrides?.description ?? `${type} task description`,
    type,
    status: 'running',
    dependencies: [],
    contract: {
      objective: overrides?.objective ?? `Perform ${type}`,
      allowedScope: overrides?.allowedScope ?? ['*'],
      forbiddenChanges: overrides?.forbiddenChanges ?? [],
      acceptanceCriteria: overrides?.acceptanceCriteria ?? ['Criteria 1'],
      dependencies: [],
      completionMode: overrides?.completionMode,
      verification: overrides?.verification,
    },
    acceptanceCriteria: ['Criteria 1'],
    reworkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createAgentResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    success: true,
    message: 'Task completed successfully',
    output: 'Substantive analysis and verification output exceeding twenty characters.',
    completionReason: 'NORMAL_COMPLETION',
    filesModified: [],
    durationMs: 1000,
    ...overrides,
  };
}

describe('CompletionGate - Task-Type Aware Policy Matrix', () => {
  const gate = new CompletionGate();

  // 1. Implementation
  describe('implementation', () => {
    it('requires code changes and rejects zero-diff execution', async () => {
      const task = createTask('implementation');
      const agentResult = createAgentResult({ filesModified: [], output: 'Did some invisible work' });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base', // identical commit
        verificationPassed: true,
      });

      expect(result.accepted).toBe(false);
      expect(result.failureReason).toBe('NO_CHANGES_PRODUCED');
      expect(result.evidence?.explanation).toContain('IMPLEMENTATION');
    });

    it('accepts execution with file modifications or commit produced', async () => {
      const task = createTask('implementation');
      const agentResult = createAgentResult({ filesModified: ['src/feature.ts'], commitHash: 'commit-new' });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-new',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(true);
      expect(result.evidence?.commitsProduced).toContain('commit-new');
    });
  });

  // 2. Refactoring
  describe('refactoring', () => {
    it('requires code changes and rejects zero-diff execution', async () => {
      const task = createTask('refactoring', {
        title: 'Refactor router engine',
        objective: 'Clean up router modules',
      });
      const agentResult = createAgentResult({ filesModified: [] });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(false);
      expect(result.failureReason).toBe('NO_CHANGES_PRODUCED');
      expect(result.evidence?.explanation).toContain('REFACTORING');
    });

    it('accepts refactoring with modified files', async () => {
      const task = createTask('refactoring');
      const agentResult = createAgentResult({ filesModified: ['src/router.ts'], commitHash: 'commit-refactor' });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-refactor',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(true);
    });
  });

  // 3. Investigation
  describe('investigation', () => {
    it('requires substantive report and rejects empty output without requiring commits', async () => {
      const task = createTask('investigation', {
        title: 'Investigate flaky test',
        objective: 'Analyze test failure root cause',
        forbiddenChanges: ['*'],
      });
      const agentResult = createAgentResult({ output: 'short', message: 'ok' });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(false);
      expect(result.failureReason).toBe('EMPTY_PROVIDER_RESULT');
    });

    it('accepts substantive analysis report without git changes', async () => {
      const task = createTask('investigation', {
        title: 'Investigate race condition',
        objective: 'Analyze concurrent lock contention',
        forbiddenChanges: ['*'],
      });
      const agentResult = createAgentResult({
        output: 'Root cause identified: database write lock timed out during parallel test executions.',
      });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(true);
      expect(result.evidence?.investigationReportLength).toBeGreaterThan(20);
    });
  });

  // 4. Review
  describe('review', () => {
    it('requires findings or substantive commentary and rejects empty feedback', async () => {
      const task = createTask('review', {
        title: 'Code review',
        objective: 'Review pull request',
        forbiddenChanges: ['*'],
      });
      const agentResult = createAgentResult({ output: '', findings: [] });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(false);
      expect(result.failureReason).toBe('EMPTY_PROVIDER_RESULT');
    });

    it('accepts review with structured findings', async () => {
      const task = createTask('review');
      const agentResult = createAgentResult({
        output: '',
        findings: [
          { severity: 'minor', description: 'Variable could be const', file: 'a.ts', line: 10 },
        ],
      });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(true);
      expect(result.evidence?.reviewFindingsCount).toBe(1);
    });

    it('accepts review with substantive written commentary', async () => {
      const task = createTask('review');
      const agentResult = createAgentResult({
        output: 'LGTM. All acceptance criteria met, error handling is robust, test coverage is complete.',
        findings: [],
      });

      const result = await gate.evaluate({
        task,
        agentResult,
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });

      expect(result.accepted).toBe(true);
    });
  });

  // 5. Testing
  describe('testing', () => {
    it('derives code change requirement when task semantics involve writing/authoring test files', async () => {
      const task = createTask('testing', {
        title: 'Write unit tests for scheduler',
        objective: 'Write new unit tests covering failure modes',
        allowedScope: ['packages/scheduler/tests/*'],
        forbiddenChanges: [],
      });

      const policy = resolveCompletionPolicy(task);
      expect(policy.requirement).toBe('code_change_required');

      // Rejects when 0 test files modified
      const zeroDiffResult = await gate.evaluate({
        task,
        agentResult: createAgentResult({ filesModified: [] }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });
      expect(zeroDiffResult.accepted).toBe(false);
      expect(zeroDiffResult.failureReason).toBe('NO_CHANGES_PRODUCED');

      // Accepts when test file is added
      const withFilesResult = await gate.evaluate({
        task,
        agentResult: createAgentResult({ filesModified: ['packages/scheduler/tests/failover.test.ts'], commitHash: 'commit-test' }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-test',
        verificationPassed: true,
      });
      expect(withFilesResult.accepted).toBe(true);
    });

    it('derives report requirement when task semantics involve executing/verifying tests', async () => {
      const task = createTask('testing', {
        title: 'Run test suite verification',
        objective: 'Run test suite and verify regression results',
        allowedScope: [],
        forbiddenChanges: ['*'],
      });

      const policy = resolveCompletionPolicy(task);
      expect(policy.requirement).toBe('substantive_report_required');

      // Rejects empty report
      const emptyResult = await gate.evaluate({
        task,
        agentResult: createAgentResult({ output: '' }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });
      expect(emptyResult.accepted).toBe(false);

      // Accepts substantive verification report
      const reportResult = await gate.evaluate({
        task,
        agentResult: createAgentResult({
          output: 'All 15 test suites passed (198 tests). Zero regressions detected.',
        }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });
      expect(reportResult.accepted).toBe(true);
    });

    it('accepts a baseline verification with zero git changes even when the command exits non-zero', async () => {
      const task = createTask('testing', {
        title: 'Run pnpm typecheck to establish a baseline',
        objective: 'Run pnpm typecheck to establish a baseline',
        allowedScope: [],
        forbiddenChanges: ['*'],
        completionMode: 'verification',
        verification: {
          commands: ['pnpm typecheck'],
          expectation: 'observe',
        },
      });

      const policy = resolveCompletionPolicy(task);
      expect(policy.requirement).toBe('verification_evidence_required');

      const result = await gate.evaluate({
        task,
        agentResult: createAgentResult({ output: 'Baseline captured.' }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
        verificationChecks: [
          {
            name: 'explicit-1',
            command: 'pnpm typecheck',
            exitCode: 1,
            stdout: '',
            stderr: 'Existing type errors',
            durationMs: 25,
            success: false,
          },
        ],
      });

      expect(result.accepted).toBe(true);
      expect(result.evidence.verificationChecks).toHaveLength(1);
      expect(result.evidence.filesModified).toEqual([]);
    });

    it('rejects a required-to-pass verification when its command fails', async () => {
      const task = createTask('testing', {
        title: 'Validate integration with pnpm typecheck',
        objective: 'Validate integration with pnpm typecheck',
        allowedScope: [],
        forbiddenChanges: ['*'],
        completionMode: 'verification',
        verification: {
          commands: ['pnpm typecheck'],
          expectation: 'pass',
        },
      });

      const result = await gate.evaluate({
        task,
        agentResult: createAgentResult({ output: 'Typecheck completed.' }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: false,
        verificationChecks: [
          {
            name: 'explicit-1',
            command: 'pnpm typecheck',
            exitCode: 2,
            stdout: '',
            stderr: 'New type error',
            durationMs: 25,
            success: false,
          },
        ],
      });

      expect(result.accepted).toBe(false);
      expect(result.failureReason).toBe('VERIFICATION_FAILED');
      expect(result.evidence.explanation).toContain('exit code 2');
    });

    it('rejects verification-only completion without command evidence', async () => {
      const task = createTask('testing', {
        title: 'Run pnpm lint',
        objective: 'Run pnpm lint',
        allowedScope: [],
        forbiddenChanges: ['*'],
        completionMode: 'verification',
        verification: {
          commands: ['pnpm lint'],
          expectation: 'pass',
        },
      });

      const result = await gate.evaluate({
        task,
        agentResult: createAgentResult({ output: 'Lint done.' }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
        verificationChecks: [],
      });

      expect(result.accepted).toBe(false);
      expect(result.failureReason).toBe('VERIFICATION_FAILED');
      expect(result.evidence.explanation).toContain('no deterministic command evidence');
    });
  });

  // 6. Architecture
  describe('architecture', () => {
    it('derives code change requirement when task semantics involve scaffolding code structure', async () => {
      const task = createTask('architecture', {
        title: 'Scaffold packages directory',
        objective: 'Scaffold new workspace packages structure',
        allowedScope: ['packages/*'],
        forbiddenChanges: [],
      });

      const policy = resolveCompletionPolicy(task);
      expect(policy.requirement).toBe('code_change_required');

      // Rejects zero-diff
      const zeroDiff = await gate.evaluate({
        task,
        agentResult: createAgentResult({ filesModified: [] }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });
      expect(zeroDiff.accepted).toBe(false);
      expect(zeroDiff.failureReason).toBe('NO_CHANGES_PRODUCED');

      // Accepts scaffold commit
      const withCode = await gate.evaluate({
        task,
        agentResult: createAgentResult({ filesModified: ['packages/new-pkg/package.json'], commitHash: 'commit-scaffold' }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-scaffold',
        verificationPassed: true,
      });
      expect(withCode.accepted).toBe(true);
    });

    it('derives design evidence requirement when task semantics involve architecture ADR/design RFC', async () => {
      const task = createTask('architecture', {
        title: 'Design distributed lock ADR',
        objective: 'Draft architecture proposal and ADR for distributed locking',
        allowedScope: [],
        forbiddenChanges: ['*'],
      });

      const policy = resolveCompletionPolicy(task);
      expect(policy.requirement).toBe('substantive_report_required');

      // Rejects empty report
      const emptyResult = await gate.evaluate({
        task,
        agentResult: createAgentResult({ output: '' }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });
      expect(emptyResult.accepted).toBe(false);

      // Accepts substantive ADR report
      const adrResult = await gate.evaluate({
        task,
        agentResult: createAgentResult({
          output: 'ADR-004: Distributed locking mechanism using SQLite file lock with exponential backoff.',
        }),
        baseCommit: 'commit-base',
        resultingCommit: 'commit-base',
        verificationPassed: true,
      });
      expect(adrResult.accepted).toBe(true);
    });
  });

  // 7. Exhaustive check
  describe('exhaustive type check', () => {
    it('throws error when unhandled task type is encountered', () => {
      const fakeTask = {
        ...createTask('implementation'),
        type: 'unregistered_type' as any,
      };
      expect(() => resolveCompletionPolicy(fakeTask)).toThrow('Unhandled TaskType');
    });
  });
});
