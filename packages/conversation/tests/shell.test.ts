import { describe, it, expect } from 'vitest';
import { InteractiveShell } from '../src/interactive-shell.js';

describe('InteractiveShell (REPL)', () => {
  it('renders initial startup banner with repo and agent status', async () => {
    const shell = new InteractiveShell();
    const banner = await shell.renderBanner();

    expect(banner).toContain('TaskForge');
    expect(banner).toContain('Agents');
    expect(banner).toContain('Router');
  });

  it('processes user commands in conversational REPL', async () => {
    const shell = new InteractiveShell();

    // Check agents command
    const defaultAgentsReply = await shell.handleInput('/agents');
    expect(defaultAgentsReply).toContain('Available agents:');

    // Check agents inspection via natural language
    const agentReply = await shell.handleInput('who is available?');
    expect(agentReply).toContain('Available agents:');

    // Check pause and resume
    const pauseReply = await shell.handleInput('pause execution');
    expect(pauseReply).toContain('Execution paused safely');

    const resumeReply = await shell.handleInput('resume execution');
    expect(resumeReply).toContain('Execution resumed');

    // Check constraint command
    const constraintReply = await shell.handleInput('do not change .env files');
    expect(constraintReply).toContain('Constraint added successfully');

    // Check plan proposal flow
    const goalReply = await shell.handleInput('create application health endpoint');
    expect(goalReply).toContain('Understood. Recommended strategy:');
    expect(goalReply).toContain('structured tasks:');
    expect(goalReply).toContain('Do you want me to execute?');

    // Check /plan
    const planReply = await shell.handleInput('/plan');
    expect(planReply).toContain('Current task plan:');

    // Check approval and execution with 'yes --fake'
    const approveReply = await shell.handleInput('yes --fake');
    expect(approveReply).toContain('Plan executed successfully!');

    // Check second plan and approve with 'y --fake'
    await shell.handleInput('create metrics dashboard');
    const yReply = await shell.handleInput('y --fake');
    expect(yReply).toContain('Plan executed successfully!');

    // Check /stream when idle
    const streamIdleReply = await shell.handleInput('/stream');
    expect(streamIdleReply).toContain('No active agent tasks currently streaming');

    // Check /stream when an agent is actively tracked
    shell.activityTracker.register({
      taskId: 'task-test-stream',
      agentId: 'claude',
      agentName: 'Claude Code',
      status: 'Building packages...',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    });
    const streamActiveReply = await shell.handleInput('/stream');
    expect(streamActiveReply).toContain('Live Stream:');
    expect(streamActiveReply).toContain('task-test-stream');
    expect(streamActiveReply).toContain('Claude Code');
    expect(streamActiveReply).toContain('[1: task-test-stream]');
  });
});
