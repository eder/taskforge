import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentAssignment, AgentResult, CollaborationProposal, TaskForgeConfig } from '@taskforge/shared';
import { Task } from '@taskforge/core';
import { AgentAdapter, AgentActivityTracker } from '@taskforge/agents';
import { WorktreeManager } from '@taskforge/workspace';
import {
  AssignmentRepository,
  EventRepository,
  ExecutionRepository,
  WorkspaceRepository,
} from '@taskforge/persistence';
import { InteractionGateway } from '@taskforge/execution';

export interface GovernedAssignmentContext {
  runId: string;
  baseCommit: string;
  repoRoot: string;
  config: TaskForgeConfig;
  task: Task;
  /** Assignment must already be persisted via assignmentRepo.create before calling. */
  assignment: AgentAssignment;
  agent: AgentAdapter;
  /** Read-only isolated worktree, used for investigation/review-style roles. */
  detached?: boolean;
  /** Reuse an already-provisioned worktree instead of creating a fresh one (e.g. a pair handoff). */
  existingWorktree?: { path: string; branchName?: string };
  objectiveOverride?: string;
  worktreeManager: WorktreeManager;
  workspaceRepo: WorkspaceRepository;
  assignmentRepo: AssignmentRepository;
  executionRepo: ExecutionRepository;
  eventRepo: EventRepository;
  interactionGateway?: InteractionGateway;
  activityTracker?: AgentActivityTracker;
  abortSignal?: AbortSignal;
  /** Optional hooks for callers that also track task-level (not just assignment-level) state. */
  onAttention?: (kind: 'waiting_permission' | 'waiting_input' | 'waiting_auth') => void;
  onResumed?: () => void;
}

export interface GovernedAssignmentResult {
  success: boolean;
  commitHash?: string;
  output?: string;
  message?: string;
  worktreePath: string;
  /** As reported by the agent's own execution result. */
  durationMs: number;
  collaborationProposal?: CollaborationProposal;
}

/**
 * Runs a single agent assignment through the same governance pipeline the
 * single-agent scheduler path uses: isolated worktree, workspace + execution
 * records, and every AgentRuntimeEvent (permission/question/auth) routed
 * through the InteractionGateway. Callers own task-level status transitions,
 * verification and integration, and activityTracker.complete(task.id).
 */
export async function executeGovernedAssignment(
  ctx: GovernedAssignmentContext,
): Promise<GovernedAssignmentResult> {
  const { task, assignment, agent, runId, baseCommit, abortSignal } = ctx;

  ctx.activityTracker?.register({
    taskId: task.id,
    assignmentId: assignment.id,
    taskTitle: task.title,
    agentId: agent.id,
    agentName: agent.name,
    role: assignment.role,
    status: 'Provisioning isolated workspace...',
    startedAt: new Date(),
    lastActiveAt: new Date(),
  });

  ctx.eventRepo.append({
    id: `evt-${randomUUID()}`,
    runId,
    taskId: task.id,
    type: 'ASSIGNMENT_CREATED',
    payload: { assignmentId: assignment.id, agentId: agent.id },
    timestamp: new Date(),
  });

  const wt = ctx.existingWorktree
    ? { path: ctx.existingWorktree.path, branchName: ctx.existingWorktree.branchName ?? '' }
    : await ctx.worktreeManager.createWorktree(task.id, assignment.id, baseCommit, {
        detached: ctx.detached,
      });
  assignment.worktreePath = wt.path;
  assignment.branchName = wt.branchName;

  ctx.workspaceRepo.register({
    id: `ws-${task.id}-${randomUUID().slice(0, 8)}`,
    runId,
    taskId: task.id,
    assignmentId: assignment.id,
    path: wt.path,
    branch: wt.branchName,
  });

  const logPath = path.resolve(
    ctx.repoRoot,
    ctx.config.execution.runsDir,
    runId,
    `${task.id}-${assignment.id}.log`,
  );

  const activeState = ctx.activityTracker?.getByTaskId(task.id);
  if (activeState) {
    activeState.logPath = logPath;
    activeState.status = 'Agent executing in worktree...';
  }

  const execRecord = ctx.executionRepo.create({
    id: `exec-${task.id}-${randomUUID().slice(0, 8)}`,
    runId,
    taskId: task.id,
    assignmentId: assignment.id,
    agentId: agent.id,
    logPath,
  });

  const taskContract = ctx.objectiveOverride
    ? { ...task.contract, objective: ctx.objectiveOverride }
    : task.contract;

  let session: import('@taskforge/shared').AgentSession | undefined;
  if (agent.createSession) {
    session = await agent.createSession(assignment, {
      worktreePath: wt.path,
      task: taskContract,
      assignment,
      abortSignal,
    });

    if (ctx.interactionGateway && session) {
      (async () => {
        try {
          for await (const event of session.events()) {
            if (event.type === 'permission_request') {
              ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_permission');
              ctx.onAttention?.('waiting_permission');
              ctx.activityTracker?.setAttention(task.id, {
                type: 'permission',
                prompt: (event as any).prompt || 'Permission approval required',
                resource: (event as any).resource,
              });
            } else if (event.type === 'question') {
              ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_input');
              ctx.onAttention?.('waiting_input');
              ctx.activityTracker?.setAttention(task.id, {
                type: 'question',
                prompt: (event as any).prompt || 'Question answer required',
              });
            } else if (event.type === 'authentication_required') {
              ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_auth');
              ctx.onAttention?.('waiting_auth');
              ctx.activityTracker?.setAttention(task.id, {
                type: 'auth',
                prompt: (event as any).prompt || 'Authentication required',
              });
            }

            await ctx.interactionGateway!.handleEvent(event, session, {
              runId,
              taskId: task.id,
              assignmentId: assignment.id,
              agentId: agent.id,
            });

            ctx.activityTracker?.clearAttention(task.id);
            ctx.activityTracker?.updateStatus(task.id, 'Resumed work after approval');
            ctx.assignmentRepo.updateStatus(assignment.id, 'running');
            ctx.onResumed?.();
          }
        } catch {
          // session closed
        }
      })();
    }
  }

  let agentResult: AgentResult;
  try {
    agentResult = await agent.execute(assignment, {
      worktreePath: wt.path,
      task: taskContract,
      assignment,
      abortSignal,
      logPath,
      onActivity: (activity: string) => {
        ctx.activityTracker?.updateStatus(task.id, activity);
      },
      onEvent: async (event) => {
        if (ctx.interactionGateway && session) {
          if (event.type === 'permission_request') {
            ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_permission');
            ctx.onAttention?.('waiting_permission');
            ctx.activityTracker?.setAttention(task.id, {
              type: 'permission',
              prompt: (event as any).prompt || 'Permission approval required',
              resource: (event as any).resource,
            });
          }
          await ctx.interactionGateway.handleEvent(event, session, {
            runId,
            taskId: task.id,
            assignmentId: assignment.id,
            agentId: agent.id,
          });
          ctx.activityTracker?.clearAttention(task.id);
          ctx.activityTracker?.updateStatus(task.id, 'Resumed work after approval');
          ctx.assignmentRepo.updateStatus(assignment.id, 'running');
          ctx.onResumed?.();
        }
      },
    });
  } finally {
    // The assignment has finished (successfully, with a failure, or by
    // throwing) — end the session's event loop and drop the adapter's
    // reference so long-running REPLs don't accumulate one session per
    // assignment forever. This is normal teardown, not a cancellation.
    if (session) {
      await session.close();
    }
    agent.releaseSession?.(assignment.id);
  }

  ctx.executionRepo.complete(
    execRecord.id,
    agentResult.success ? 'success' : 'failed',
    agentResult.success ? 0 : 1,
    agentResult.message,
  );

  ctx.assignmentRepo.updateStatus(assignment.id, agentResult.success ? 'completed' : 'failed');

  return {
    success: agentResult.success,
    commitHash: agentResult.commitHash,
    output: agentResult.output,
    message: agentResult.message,
    worktreePath: wt.path,
    durationMs: agentResult.durationMs,
    collaborationProposal: agentResult.collaborationProposal,
  };
}
