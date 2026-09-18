import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeAgent } from '../src/fake-agent.js';
import { AgentRegistry, AgentDetector } from '../src/agent-registry.js';
import { GitService } from '@taskforge/workspace';

describe('Agents - FakeAgent and Registry', () => {
  const testDir = path.resolve(__dirname, '../../test-tmp-agent');

  beforeEach(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    const git = new GitService(testDir);
    // initialize git in test dir
    await git['exec'](['init', '-b', 'main'], testDir);
    await git['exec'](['config', 'user.name', 'Test Agent'], testDir);
    await git['exec'](['config', 'user.email', 'agent@test.local'], testDir);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('FakeAgent writes files and creates a git commit', async () => {
    const agent = new FakeAgent('fake-writer', 'Fake Writer');
    agent.addAction({
      writeFile: {
        path: 'src/solution.ts',
        content: 'export const answer = 42;\n',
      },
      gitCommitMessage: 'feat(TASK-1): write solution',
    });

    const result = await agent.execute(
      {
        id: 'ASGN-1',
        taskId: 'TASK-1',
        agentId: 'fake-writer',
        role: 'implementer',
        objective: 'Write solution',
        status: 'running',
      },
      {
        worktreePath: testDir,
        task: {
          objective: 'Write solution',
          allowedScope: ['src/**'],
          forbiddenChanges: [],
          acceptanceCriteria: ['answer is 42'],
          dependencies: [],
        },
        assignment: {
          id: 'ASGN-1',
          taskId: 'TASK-1',
          agentId: 'fake-writer',
          role: 'implementer',
          objective: 'Write solution',
          status: 'running',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(fs.existsSync(path.join(testDir, 'src/solution.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(testDir, 'src/solution.ts'), 'utf8')).toBe(
      'export const answer = 42;\n',
    );
  });

  it('FakeAgent handles failure cleanly', async () => {
    const agent = new FakeAgent('fake-failer', 'Fake Failer', [
      {
        shouldFail: true,
        failMessage: 'Simulated bug',
      },
    ]);

    const result = await agent.execute(
      {
        id: 'ASGN-2',
        taskId: 'TASK-2',
        agentId: 'fake-failer',
        role: 'implementer',
        objective: 'Fail task',
        status: 'running',
      },
      {
        worktreePath: testDir,
        task: {
          objective: 'Fail task',
          allowedScope: [],
          forbiddenChanges: [],
          acceptanceCriteria: [],
          dependencies: [],
        },
        assignment: {
          id: 'ASGN-2',
          taskId: 'TASK-2',
          agentId: 'fake-failer',
          role: 'implementer',
          objective: 'Fail task',
          status: 'running',
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Simulated bug');
  });

  it('AgentRegistry and AgentDetector detect registered harnesses', async () => {
    const registry = new AgentRegistry();
    const fake = new FakeAgent('custom-fake', 'Custom Fake');
    registry.register(fake);

    expect(registry.get('custom-fake')).toBe(fake);
    expect(registry.get('claude')).toBeDefined();

    const reports = await AgentDetector.detect(registry.list());
    expect(reports.length).toBeGreaterThanOrEqual(4);
    const fakeReport = reports.find((r) => r.id === 'custom-fake');
    expect(fakeReport?.ready).toBe(true);
  });
});
