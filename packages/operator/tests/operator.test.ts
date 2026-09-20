import { describe, it, expect } from 'vitest';
import { OperatorAgent } from '../src/operator-agent.js';

describe('OperatorAgent Intent Layer', () => {
  const operator = new OperatorAgent();

  it('parses slash commands', () => {
    expect(operator.parseIntent('/agents').type).toBe('inspect_agents');
    expect(operator.parseIntent('/tasks').type).toBe('inspect_tasks');
    expect(operator.parseIntent('/plan').type).toBe('inspect_plan');
    expect(operator.parseIntent('/pause').type).toBe('pause_execution');
    expect(operator.parseIntent('/resume').type).toBe('resume_execution');
    expect(operator.parseIntent('/approve').type).toBe('approve_plan');
    expect(operator.parseIntent('/reject').type).toBe('reject_plan');

    const reassign = operator.parseIntent('/reassign TASK-1 agent-2');
    expect(reassign.type).toBe('cancel_and_reassign');
    if (reassign.type === 'cancel_and_reassign') {
      expect(reassign.taskId).toBe('TASK-1');
      expect(reassign.targetAgentId).toBe('agent-2');
    }

    const constraint = operator.parseIntent('/constraint Do not delete migrations');
    expect(constraint.type).toBe('add_constraint');
    if (constraint.type === 'add_constraint') {
      expect(constraint.constraint).toBe('Do not delete migrations');
    }

    const apply = operator.parseIntent('/apply run-123');
    expect(apply.type).toBe('apply_run');
    if (apply.type === 'apply_run') expect(apply.runId).toBe('run-123');

    const applyNoArg = operator.parseIntent('/apply');
    expect(applyNoArg.type).toBe('apply_run');
    if (applyNoArg.type === 'apply_run') expect(applyNoArg.runId).toBeUndefined();

    const diff = operator.parseIntent('/diff run-123');
    expect(diff.type).toBe('diff_run');
    if (diff.type === 'diff_run') expect(diff.runId).toBe('run-123');

    const pr = operator.parseIntent('/pr run-123');
    expect(pr.type).toBe('create_pr');
    if (pr.type === 'create_pr') expect(pr.runId).toBe('run-123');

    const discard = operator.parseIntent('/discard run-123');
    expect(discard.type).toBe('discard_run');
    if (discard.type === 'discard_run') expect(discard.runId).toBe('run-123');
  });

  it('parses natural language intents', () => {
    expect(operator.parseIntent('who is available?').type).toBe('inspect_agents');
    expect(operator.parseIntent('show available agents').type).toBe('inspect_agents');

    expect(operator.parseIntent('list tasks').type).toBe('inspect_tasks');
    expect(operator.parseIntent('what is happening with tasks?').type).toBe('inspect_tasks');

    expect(operator.parseIntent('please pause execution').type).toBe('pause_execution');
    expect(operator.parseIntent('resume execution now').type).toBe('resume_execution');

    const constraintIntent = operator.parseIntent('do not modify database schema');
    expect(constraintIntent.type).toBe('add_constraint');

    const reassignIntent = operator.parseIntent('reassign TASK-9 to codex');
    expect(reassignIntent.type).toBe('cancel_and_reassign');

    const goalIntent = operator.parseIntent('implement API key authentication support');
    expect(goalIntent.type).toBe('submit_goal');
    if (goalIntent.type === 'submit_goal') {
      expect(goalIntent.goal).toBe('implement API key authentication support');
    }

    expect(operator.parseIntent('aplica as mudanças').type).toBe('apply_run');
    expect(operator.parseIntent('merge this').type).toBe('apply_run');
    expect(operator.parseIntent('put this on main').type).toBe('apply_run');

    expect(operator.parseIntent('descarta').type).toBe('discard_run');
    expect(operator.parseIntent("don't apply this").type).toBe('discard_run');

    expect(operator.parseIntent('show me what changed').type).toBe('diff_run');
    expect(operator.parseIntent('mostra as mudanças').type).toBe('diff_run');

    expect(operator.parseIntent('create a pr').type).toBe('create_pr');
    expect(operator.parseIntent('cria um pr').type).toBe('create_pr');
  });

  it('formats responses for each intent', () => {
    const resp = operator.formatResponse(
      { type: 'inspect_tasks' },
      {
        tasks: [
          { id: 'TASK-1', title: 'Init', status: 'completed' },
          { id: 'TASK-2', title: 'Build', status: 'running' },
        ],
      },
    );
    expect(resp).toContain('TASK-1');
    expect(resp).toContain('COMPLETED');
    expect(resp).toContain('TASK-2');
    expect(resp).toContain('RUNNING');
  });
});
