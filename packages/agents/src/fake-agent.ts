import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentMessage,
  AgentResult,
  ReviewFinding,
} from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';
import { AgentAdapter } from './adapter-interface.js';

export interface FakeAgentAction {
  writeFile?: {
    path: string;
    content: string;
  };
  deleteFile?: string;
  gitCommitMessage?: string;
  delayMs?: number;
  shouldFail?: boolean;
  failMessage?: string;
  findings?: ReviewFinding[];
  collaborationProposal?: import('@taskforge/shared').CollaborationProposal;
}

export class FakeAgent implements AgentAdapter {
  public id: string;
  public name: string;
  public actions: FakeAgentAction[] = [];
  public executedAssignments: AgentAssignment[] = [];
  public receivedMessages: AgentMessage[] = [];

  constructor(
    id: string = 'fake-agent',
    name: string = 'Fake Agent',
    actions: FakeAgentAction[] = [],
  ) {
    this.id = id;
    this.name = name;
    this.actions = actions;
  }

  addAction(action: FakeAgentAction): this {
    this.actions.push(action);
    return this;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      canRead: true,
      canWrite: true,
      canExecute: true,
      languages: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust'],
      tools: ['bash', 'file_editor', 'git'],
    };
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.executedAssignments.push(assignment);
    const startTime = Date.now();

    // Default action if none specified
    const action = this.actions.shift() ?? {
      gitCommitMessage: `feat(${assignment.taskId}): completed by ${this.id}`,
    };

    if (action.delayMs && action.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, action.delayMs));
    }

    if (context.abortSignal?.aborted) {
      return {
        success: false,
        message: 'Assignment cancelled',
        durationMs: Date.now() - startTime,
      };
    }

    if (action.writeFile) {
      const filePath = path.resolve(context.worktreePath, action.writeFile.path);
      const parent = path.dirname(filePath);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      fs.writeFileSync(filePath, action.writeFile.content, 'utf8');
    }

    if (action.deleteFile) {
      const filePath = path.resolve(context.worktreePath, action.deleteFile);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    let commitHash: string | undefined;
    if (action.gitCommitMessage) {
      const git = new GitService(context.worktreePath);
      commitHash = await git.stageAndCommit(action.gitCommitMessage, context.worktreePath);
    }

    if (action.collaborationProposal) {
      return {
        success: false,
        commitHash,
        message: action.failMessage ?? `Collaboration escalated by ${this.id}`,
        durationMs: Date.now() - startTime,
        findings: action.findings,
        collaborationProposal: action.collaborationProposal,
      };
    }

    if (action.shouldFail) {
      return {
        success: false,
        commitHash,
        message: action.failMessage ?? `Failure simulated by ${this.id}`,
        durationMs: Date.now() - startTime,
        findings: action.findings,
      };
    }

    return {
      success: true,
      commitHash,
      message: `Assignment ${assignment.id} completed successfully by ${this.id}`,
      output: `Executed ${assignment.objective}`,
      durationMs: Date.now() - startTime,
      findings: action.findings,
    };
  }

  async send(_sessionId: string, message: AgentMessage): Promise<void> {
    this.receivedMessages.push(message);
  }

  async cancel(_sessionId: string): Promise<void> {}
}
