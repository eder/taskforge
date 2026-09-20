import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentAssignment,
  AgentCapabilities,
  AgentContext,
  AgentMessage,
  AgentResult,
  AgentSession,
  ReviewFinding,
} from '@taskforge/shared';
import { GitService } from '@taskforge/workspace';
import { AgentAdapter } from './adapter-interface.js';
import { FakeAgentSession } from './agent-session.js';

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
  requestPermission?: {
    category: string;
    operation: string;
    resource: string;
    prompt: string;
  };
  askQuestion?: {
    prompt: string;
    options?: string[];
  };
  requireConfirmation?: {
    prompt: string;
  };
  requireAuth?: {
    prompt: string;
    service?: string;
  };
  activitySteps?: string[];
}

export class FakeAgent implements AgentAdapter {
  public id: string;
  public name: string;
  public actions: FakeAgentAction[] = [];
  public executedAssignments: AgentAssignment[] = [];
  public receivedMessages: AgentMessage[] = [];
  public activeSessions: Map<string, FakeAgentSession> = new Map();

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

  async createSession(assignment: AgentAssignment, _context: AgentContext): Promise<AgentSession> {
    const sessionId = `session-${assignment.id}`;
    const session = new FakeAgentSession(sessionId, assignment.id);
    this.activeSessions.set(assignment.id, session);
    return session;
  }

  async execute(assignment: AgentAssignment, context: AgentContext): Promise<AgentResult> {
    this.executedAssignments.push(assignment);
    const startTime = Date.now();
    const session = this.activeSessions.get(assignment.id);

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

    // Interactive Trigger: Permission Request
    if (action.requestPermission) {
      const requestId = `req-perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const permEvent: import('@taskforge/shared').PermissionRequestEvent = {
        type: 'permission_request',
        sessionId: session?.sessionId ?? `session-${assignment.id}`,
        assignmentId: assignment.id,
        agentId: this.id,
        requestId,
        category: action.requestPermission.category,
        operation: action.requestPermission.operation,
        resource: action.requestPermission.resource,
        prompt: action.requestPermission.prompt,
        timestamp: new Date().toISOString(),
      };

      if (session) {
        session.pushEvent(permEvent);
        const resp = await session.waitForResponse(requestId);
        if (resp.decision === 'deny' || resp.decision === 'cancel') {
          return {
            success: false,
            message: `Permission denied: ${action.requestPermission.operation}`,
            output: resp.payload,
            durationMs: Date.now() - startTime,
          };
        }
      } else if (context.onEvent) {
        await context.onEvent(permEvent);
      }
    }

    // Interactive Trigger: Question
    if (action.askQuestion) {
      const requestId = `req-q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const qEvent: import('@taskforge/shared').AgentQuestionEvent = {
        type: 'question',
        sessionId: session?.sessionId ?? `session-${assignment.id}`,
        assignmentId: assignment.id,
        agentId: this.id,
        requestId,
        prompt: action.askQuestion.prompt,
        options: action.askQuestion.options,
        timestamp: new Date().toISOString(),
      };

      if (session) {
        session.pushEvent(qEvent);
        const resp = await session.waitForResponse(requestId);
        if (resp.decision === 'deny' || resp.decision === 'cancel') {
          return {
            success: false,
            message: `Question denied/cancelled`,
            output: resp.payload,
            durationMs: Date.now() - startTime,
          };
        }
      } else if (context.onEvent) {
        await context.onEvent(qEvent);
      }
    }

    // Interactive Trigger: Confirmation
    if (action.requireConfirmation) {
      const requestId = `req-conf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const confEvent: import('@taskforge/shared').ConfirmationRequestEvent = {
        type: 'confirmation_request',
        sessionId: session?.sessionId ?? `session-${assignment.id}`,
        assignmentId: assignment.id,
        agentId: this.id,
        requestId,
        prompt: action.requireConfirmation.prompt,
        timestamp: new Date().toISOString(),
      };

      if (session) {
        session.pushEvent(confEvent);
        const resp = await session.waitForResponse(requestId);
        if (resp.decision === 'deny' || resp.decision === 'cancel') {
          return {
            success: false,
            message: `Confirmation rejected`,
            durationMs: Date.now() - startTime,
          };
        }
      } else if (context.onEvent) {
        await context.onEvent(confEvent);
      }
    }

    // Interactive Trigger: Authentication Required
    if (action.requireAuth) {
      const requestId = `req-auth-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const authEvent: import('@taskforge/shared').AuthenticationRequiredEvent = {
        type: 'authentication_required',
        sessionId: session?.sessionId ?? `session-${assignment.id}`,
        assignmentId: assignment.id,
        agentId: this.id,
        requestId,
        prompt: action.requireAuth.prompt,
        service: action.requireAuth.service,
        timestamp: new Date().toISOString(),
      };

      if (session) {
        session.pushEvent(authEvent);
        const resp = await session.waitForResponse(requestId);
        if (resp.decision === 'deny' || resp.decision === 'cancel') {
          return {
            success: false,
            message: `Authentication failed or denied`,
            durationMs: Date.now() - startTime,
          };
        }
      } else if (context.onEvent) {
        await context.onEvent(authEvent);
      }
    }

    if (context.logPath) {
      try {
        const logDir = path.dirname(context.logPath);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        fs.appendFileSync(
          context.logPath,
          `[FakeAgent] Starting assignment ${assignment.id} (${this.name})\n`,
        );
      } catch {
        // ignore log error
      }
    }

    if (action.activitySteps && action.activitySteps.length > 0) {
      for (const step of action.activitySteps) {
        context.onActivity?.(step);
        if (context.logPath) {
          try {
            fs.appendFileSync(context.logPath, `[FakeAgent] ${step}\n`);
          } catch {
            // ignore
          }
        }
      }
    } else if (action.writeFile) {
      context.onActivity?.(`Writing ${action.writeFile.path}...`);
      if (context.logPath) {
        try {
          fs.appendFileSync(context.logPath, `[FakeAgent] Writing ${action.writeFile.path}\n`);
        } catch {
          // ignore
        }
      }
    } else {
      context.onActivity?.(`Analyzing workspace...`);
      if (context.logPath) {
        try {
          fs.appendFileSync(context.logPath, `[FakeAgent] Analyzing workspace...\n`);
        } catch {
          // ignore
        }
      }
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

  async cancel(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      await session.cancel();
    }
  }

  releaseSession(assignmentId: string): void {
    this.activeSessions.delete(assignmentId);
  }
}
