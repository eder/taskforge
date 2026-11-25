import { describe, expect, it, vi } from 'vitest';
import type { Goal } from '@taskforge/shared';
import { SemanticPlanner } from '../src/semantic-planner.js';

describe('SemanticPlanner agent escalation & rich prior-context decomposition', () => {
  const validParallelPlan = {
    summary: 'Parallel improvements across config, docs, and negotiator',
    tasks: [
      {
        taskId: 'TASK-01',
        title: 'Complete scopedCommands in project config',
        description: 'Add missing package scopes in .taskforge/config.yaml',
        type: 'implementation',
        dependencies: [],
        objective: 'Add missing scopedCommands entries for core, execution, telemetry',
        allowedScope: ['.taskforge/config.yaml'],
        acceptanceCriteria: ['Config loads cleanly'],
      },
      {
        taskId: 'TASK-02',
        title: 'Clarify experimental status of remote adapters in docs',
        description: 'Update architecture docs and README for remote stubs',
        type: 'implementation',
        dependencies: [],
        objective: 'Mark DockerWorkerAdapter and SshWorkerAdapter as experimental stubs in docs',
        allowedScope: ['docs/architecture-phases-14-22.md'],
        acceptanceCriteria: ['Docs accurately describe stub status'],
      },
      {
        taskId: 'TASK-03',
        title: 'Cross-agent review of changes',
        description: 'Review both parallel changes for regressions',
        type: 'review',
        dependencies: ['TASK-01', 'TASK-02'],
        objective: 'Verify config and doc updates are consistent',
        acceptanceCriteria: ['Review approved'],
      },
    ],
  };

  it('escalates to agentCaller when a small/local router model fails schema validation instead of collapsing to 2-task heuristic', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                // Invalid plan that mimics a small 3B model failing validation
                content: JSON.stringify({
                  tasks: [
                    {
                      taskId: '1',
                      title: 'Bad task',
                      description: 'Invalid review with writable scope',
                      type: 'review',
                      dependencies: [],
                      objective: 'Invalid',
                      allowedScope: ['src/**'],
                      completionMode: 'review',
                      acceptanceCriteria: ['done'],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const agentCaller = vi.fn().mockResolvedValue(validParallelPlan);

    try {
      const planner = new SemanticPlanner({
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5-coder:3b',
        maxRetries: 0,
        agentPlanning: 'auto',
        agentCaller,
      });

      const goal: Goal = {
        id: 'goal-esc-1',
        description: 'Vamos fazer todas features necessárias',
        context:
          'REFERENCE DATA:\n1. Corrigir workers remotos em docs/architecture-phases-14-22.md\n2. Completar scopedCommands em .taskforge/config.yaml\n3. Melhorar cobertura de pacotes críticos\n4. Modularizar interactive-shell.ts',
        repository: '/repo',
        constraints: [],
        acceptanceCriteria: [],
        createdAt: new Date(),
      };

      const graph = await planner.plan(goal);
      expect(agentCaller).toHaveBeenCalledTimes(1);
      expect(graph.getAllTasks()).toHaveLength(3);
      expect(graph.metadata?.source).toBe('semantic');
      // Both TASK-01 and TASK-02 have zero dependencies -> run in parallel across multiple agents!
      expect(graph.getTask('TASK-01')?.dependencies).toEqual([]);
      expect(graph.getTask('TASK-02')?.dependencies).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses agentCaller without an OpenAI key when a short follow-up prompt carries rich goal.context', async () => {
    const agentCaller = vi.fn().mockResolvedValue(validParallelPlan);

    const planner = new SemanticPlanner({
      apiKey: undefined,
      agentPlanning: 'auto',
      agentCaller,
    });

    const goal: Goal = {
      id: 'goal-ctx-1',
      description: 'Vamos fazer todas features necessárias',
      context:
        'REFERENCE DATA:\n1. Corrigir workers remotos\n2. Completar scopedCommands em .taskforge/config.yaml\n3. Modularizar arquivos grandes',
      repository: '/repo',
      constraints: [],
      acceptanceCriteria: [],
      createdAt: new Date(),
    };

    const graph = await planner.plan(goal);
    expect(agentCaller).toHaveBeenCalledTimes(1);
    expect(graph.getAllTasks()).toHaveLength(3);
  });
});
