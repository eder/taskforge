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
    const agentReply = await shell.handleInput('/agents');
    expect(agentReply).toContain('Agentes disponíveis:');

    // Check pause and resume
    const pauseReply = await shell.handleInput('pausar a execução');
    expect(pauseReply).toContain('pausada');

    const resumeReply = await shell.handleInput('retomar a execução');
    expect(resumeReply).toContain('retomada');

    // Check constraint command
    const constraintReply = await shell.handleInput('não altere arquivos .env');
    expect(constraintReply).toContain('Restrição');

    // Check plan negotiation flow
    const goalReply = await shell.handleInput('criar endpoint de status da aplicação');
    expect(goalReply).toContain('Estratégia recomendada:');
    expect(goalReply).toContain('tarefas estruturadas');

    // Check /plan
    const planReply = await shell.handleInput('/plan');
    expect(planReply).toContain('Plano atual de tarefas:');
  });

  it('processes user commands in English conversational REPL', async () => {
    const shell = new InteractiveShell();

    // Check pause and resume in English
    const pauseReply = await shell.handleInput('pause execution');
    expect(pauseReply).toContain('Execution paused safely');

    const resumeReply = await shell.handleInput('resume execution');
    expect(resumeReply).toContain('Execution resumed');

    // Check constraint in English
    const constraintReply = await shell.handleInput('do not change .env files');
    expect(constraintReply).toContain('Constraint added successfully');

    // Check plan negotiation in English
    const goalReply = await shell.handleInput('create application health endpoint');
    expect(goalReply).toContain('Understood. Recommended strategy:');
    expect(goalReply).toContain('structured tasks:');
    expect(goalReply).toContain('Do you want me to execute?');

    // Check /plan in English
    const planReply = await shell.handleInput('/plan');
    expect(planReply).toContain('Current task plan:');

    // Check approval and execution in English
    const approveReply = await shell.handleInput('yes --fake');
    expect(approveReply).toContain('Plan executed successfully!');
  });
});
