import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell } from '@taskforge/conversation';
import { RawPlanOutput } from '@taskforge/planner';
import { Task } from '@taskforge/core';

async function waitForCondition(predicate: () => boolean, desc: string, timeoutMs = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for condition: ${desc}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('E2E Self-Hosting Correctness Pass (PR #10 Integration)', () => {
  let tmpDir: string;
  let db: TaskForgeDatabase;
  const shellsToClean: InteractiveShell[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-e2e-integration-'));
    db = new TaskForgeDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    for (const shell of shellsToClean) {
      shell.close();
    }
    shellsToClean.length = 0;
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('exercises full lifecycle: multiline paste → one complete goal → semantic complex planning → truthful planner provenance → plan feedback → revised TaskGraph → approval', async () => {
    const inStream = new PassThrough();
    const outStream = new PassThrough();
    let capturedTerminalOutput = '';
    outStream.on('data', (chunk) => {
      capturedTerminalOutput += chunk.toString();
    });

    const shell = new InteractiveShell({
      repoRoot: tmpDir,
      database: db,
      input: inStream,
      output: outStream,
      interactive: true,
    });
    shellsToClean.push(shell);

    // Track model proposals vs deterministic decomposition
    let modelCalledCount = 0;
    // Configure a caller that initially proposes an inadequate 2-task plan to prove policy rejection
    const mockModelCaller = vi.fn().mockImplementation(async () => {
      modelCalledCount++;
      // Return a generic 2-task proposal which must be rejected for complex goals
      const twoTaskPlan: RawPlanOutput = {
        summary: 'Collapsed 2-task plan',
        tasks: [
          {
            taskId: 'TASK-01',
            title: 'Core Implementation',
            description: 'Do everything in one massive task',
            type: 'implementation',
            dependencies: [],
            objective: 'Implement all requirements',
            allowedScope: ['*'],
            forbiddenChanges: [],
            acceptanceCriteria: ['All features implemented'],
          },
          {
            taskId: 'TASK-02',
            title: 'Verification and Review',
            description: 'Generic review and verification',
            type: 'review',
            dependencies: ['TASK-01'],
            objective: 'Review and verify',
            allowedScope: [],
            forbiddenChanges: ['*'],
            acceptanceCriteria: ['All tests pass'],
          },
        ],
      };
      return twoTaskPlan;
    });

    (shell as any).planner.setModelCaller(mockModelCaller);
    const planSpy = vi.spyOn((shell as any).planner, 'plan');

    // ──────────────────────────────────────────────────────────────────────────
    // Step 1: Raw Bracketed Paste Boundary
    // ──────────────────────────────────────────────────────────────────────────
    const runPromise = shell.start();
    await new Promise((r) => setTimeout(r, 200));

    const multilineGoal = [
      'Self-Hosting Dogfood Architecture Objective:',
      '- 1. Build an end-to-end task execution pipeline across all subsystems.',
      '- 2. Ensure CompletionGate verifies commits before marking success.',
      '- 3. Integrate with Git worktree and clean up branches safely.',
      '- 4. Implement robust task-type completion policy enforcement.',
    ].join('\n');

    // Send raw bracketed paste escape sequences: ESC[200~ <multiline> ESC[201~
    inStream.write(`\x1b[200~${multilineGoal}\x1b[201~`);

    // Wait a tick to verify no premature execution occurs
    await new Promise((r) => setTimeout(r, 100));
    expect(planSpy).not.toHaveBeenCalled();
    expect((shell as any).conversationState).toBe('IDLE');
    expect((shell as any).currentGraph).toBeUndefined();

    // Now send Enter to submit the pasted prompt
    inStream.write('\r');

    // ──────────────────────────────────────────────────────────────────────────
    // Step 2 & 3: One Complete Goal & Semantic Complex Planning
    // ──────────────────────────────────────────────────────────────────────────
    await waitForCondition(() => planSpy.mock.calls.length > 0, 'planner.plan invoked');

    // Exactly one submission occurred
    expect(planSpy).toHaveBeenCalledTimes(1);
    const receivedGoal = planSpy.mock.calls[0][0];

    // Goal was not fragmented into individual lines
    expect(receivedGoal.description).toContain('\n');
    expect(receivedGoal.description).toContain('- 1. Build an end-to-end task execution pipeline');
    expect(receivedGoal.description).toContain('- 4. Implement robust task-type completion policy enforcement.');
    expect(receivedGoal.description).not.toContain('\x1b[200~');
    expect(receivedGoal.description).not.toContain('\x1b[201~');

    // Wait for the shell to finish planning and transition to AWAITING_PLAN_APPROVAL
    await waitForCondition(
      () => (shell as any).conversationState === 'AWAITING_PLAN_APPROVAL',
      'shell enters AWAITING_PLAN_APPROVAL',
    );

    // Model was called, proposed 2 tasks, but policy rejected it and fell back to meaningful decomposition
    expect(modelCalledCount).toBeGreaterThan(1); // retried

    const initialGraph = (shell as any).currentGraph;
    expect(initialGraph).toBeDefined();
    const initialTasks: Task[] = initialGraph.getAllTasks();

    // A generic 2-task proposal was NOT accepted! Complex goal decomposition produced >= 4 tasks
    expect(initialTasks.length).toBeGreaterThanOrEqual(4);

    // All tasks have structured contracts
    for (const t of initialTasks) {
      expect(t.contract).toBeDefined();
      expect(t.contract.objective.length).toBeGreaterThan(0);
      expect(t.contract.acceptanceCriteria.length).toBeGreaterThan(0);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Step 4: Truthful Planner Provenance
    // ──────────────────────────────────────────────────────────────────────────
    expect(initialGraph.metadata?.planner).toBeDefined();
    expect(initialGraph.metadata.planner.source).toBe('deterministic_decomposition');
    expect(initialGraph.metadata.planner.fallbackReason).toBe('model_unresponsive_or_invalid');
    // Crucial: Deterministic decomposition is NOT labeled as AI model!
    expect(initialGraph.metadata.planner.model).toBeUndefined();

    // Verify terminal output displayed the truthful planner source
    await waitForCondition(
      () => capturedTerminalOutput.includes('✦ Plan Proposal'),
      'capturedTerminalOutput includes Plan Proposal',
    );
    expect(capturedTerminalOutput).toContain('Deterministic decomposition');

    // ──────────────────────────────────────────────────────────────────────────
    // Step 5 & 6: Plan Feedback → SemanticPlanner.revise → Revised TaskGraph
    // ──────────────────────────────────────────────────────────────────────────
    const reviseSpy = vi.spyOn((shell as any).planner, 'revise');

    // Submit natural language plan feedback: add task
    const feedbackLine = 'add task Comprehensive Verification and Regression Review';
    inStream.write(`${feedbackLine}\r`);

    // Wait for revision to complete and return to AWAITING_PLAN_APPROVAL
    await waitForCondition(
      () => reviseSpy.mock.calls.length > 0,
      'planner.revise invoked',
    );

    // Verify revise was called with correct argument list: (currentGraph, goal, revision)
    expect(reviseSpy).toHaveBeenCalledTimes(1);
    const [revCurrentGraph, revGoal, revRevision] = reviseSpy.mock.calls[0];
    expect(revCurrentGraph).toBeDefined();
    expect(revGoal.description).toBe(receivedGoal.description);
    expect(revRevision.revisionType).toBeDefined();
    expect(revRevision.feedback).toBe(feedbackLine);

    await waitForCondition(
      () => capturedTerminalOutput.includes('✦ Revised Plan'),
      'capturedTerminalOutput includes Revised Plan',
    );

    const revisedGraph = (shell as any).currentGraph;
    expect(revisedGraph).toBeDefined();
    expect(revisedGraph.metadata?.revised).toBe(true);

    // Graph changed: task added
    const revisedTasks: Task[] = revisedGraph.getAllTasks();
    expect(revisedTasks.length).toBe(initialTasks.length + 1);

    const addedTask = revisedTasks.find((t) =>
      t.title.toLowerCase().includes('comprehensive verification') ||
      t.description.toLowerCase().includes('verification'),
    );
    expect(addedTask).toBeDefined();
    expect(addedTask!.type).toBe('testing');

    // Graph remains an acyclic DAG
    const sorted = revisedGraph.topologicalSort();
    expect(sorted.length).toBe(revisedTasks.length);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 7: Approval (Execution in fake mode without real delivery)
    // ──────────────────────────────────────────────────────────────────────────
    inStream.write('yes --fake\r');

    await waitForCondition(
      () => capturedTerminalOutput.includes('Plan executed successfully!'),
      'plan execution succeeds in fake mode',
    );
    expect(capturedTerminalOutput).toContain('Plan executed successfully!');

    // Clean exit
    inStream.write('/exit\r');
    await runPromise;
  });
});
