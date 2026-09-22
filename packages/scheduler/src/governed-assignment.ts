import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentAssignment,
  AgentResult,
  AgentStreamBus,
  CollaborationProposal,
  TaskForgeConfig,
} from '@taskforge/shared';
import { Task, TaskGraph, computeTaskPriority } from '@taskforge/core';
import { AgentAdapter, AgentActivityTracker } from '@taskforge/agents';
import { WorktreeManager, GitService } from '@taskforge/workspace';
import {
  AssignmentRepository,
  EventRepository,
  ExecutionRepository,
  WorkspaceRepository,
} from '@taskforge/persistence';
import { InteractionGateway } from '@taskforge/execution';
import { CommunicationBus, SessionRegistry } from '@taskforge/collaboration';
import { ConcurrencyManager } from './concurrency-manager.js';

export interface GovernedAssignmentContext {
  runId: string;
  baseCommit: string;
  repoRoot: string;
  /** Verbatim request that started the run. */
  originalUserRequest?: string;
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
  streamBus?: AgentStreamBus;
  concurrency?: ConcurrencyManager;
  graph?: TaskGraph;
  priority?: number;
  communicationBus?: CommunicationBus;
  sessionRegistry?: SessionRegistry;
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
  findings?: import('@taskforge/shared').ReviewFinding[];
  normalizedOutcome?: import('@taskforge/shared').ProviderExecutionOutcome;
  completionReason?: import('@taskforge/shared').CompletionFailureReason;
}

/**
 * Runs a single agent assignment through the same governance pipeline the
 * single-agent scheduler path uses: isolated worktree, workspace + execution
 * records, and every AgentRuntimeEvent (permission/question/auth) routed
 * through the InteractionGateway. Callers own task-level status transitions,
 * verification and integration. This function owns assignment activity
 * lifecycle so completed/failed/cancelled attempts never remain visible as
 * active agents.
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

  try {
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

    const activeState = ctx.activityTracker?.getByAssignment(assignment.id);
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

    // Derived from the task contract, not a separately tracked flag: a task
    // whose forbidden changes are wildcarded is read-only. The Intent Guard
    // normalizes forbiddenChanges to ['*'] for READ_ONLY_ANALYSIS tasks, so
    // this stays authoritative even when routing/planning disagreed with the
    // original user intent.
    const mutationAllowed = !taskContract.forbiddenChanges?.includes('*');

    if (ctx.concurrency) {
      const priority =
        ctx.priority ?? (ctx.graph ? computeTaskPriority(task, ctx.graph) : (task.priority ?? 0));
      await ctx.concurrency.waitForSlot(agent.id, task.id, abortSignal, assignment.id, priority);
      ctx.concurrency.acquire(assignment.id, agent.id, task.id);
    }

    if (ctx.communicationBus) {
      ctx.communicationBus.registerAgent(assignment.id, agent);
    }

    let session: import('@taskforge/shared').AgentSession | undefined;
    let agentResult: AgentResult = { success: false, message: 'Execution did not complete', durationMs: 0 };
    let thrownError: Error | undefined;

    try {
      if (agent.createSession) {
        session = await agent.createSession(assignment, {
          worktreePath: wt.path,
          task: taskContract,
          assignment,
          originalUserRequest: ctx.originalUserRequest,
          abortSignal,
        });

        const sessionRegistry = ctx.sessionRegistry ?? ctx.communicationBus?.getSessionRegistry();
        if (sessionRegistry && session) {
          sessionRegistry.register({
            assignmentId: assignment.id,
            sessionId: session.sessionId,
            adapter: agent,
            taskId: task.id,
            runId,
          });
        }

        if (ctx.interactionGateway && session) {
          (async () => {
            try {
              for await (const event of session.events()) {
                if (event.type === 'permission_request') {
                  ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_permission');
                  ctx.onAttention?.('waiting_permission');
                  ctx.activityTracker?.setAttention(assignment.id, {
                    type: 'permission',
                    prompt: (event as any).prompt || 'Permission approval required',
                    resource: (event as any).resource,
                    operation: (event as any).operation,
                    category: (event as any).category,
                    requestId: (event as any).requestId,
                  });
                } else if (event.type === 'question') {
                  ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_input');
                  ctx.onAttention?.('waiting_input');
                  ctx.activityTracker?.setAttention(assignment.id, {
                    type: 'question',
                    prompt: (event as any).prompt || 'Question answer required',
                    requestId: (event as any).requestId,
                  });
                } else if (event.type === 'authentication_required') {
                  ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_auth');
                  ctx.onAttention?.('waiting_auth');
                  ctx.activityTracker?.setAttention(assignment.id, {
                    type: 'auth',
                    prompt: (event as any).prompt || 'Authentication required',
                    requestId: (event as any).requestId,
                  });
                }

                await ctx.interactionGateway!.handleEvent(event, session, {
                  runId,
                  taskId: task.id,
                  assignmentId: assignment.id,
                  agentId: agent.id,
                });

                ctx.activityTracker?.clearAttention(assignment.id);
                ctx.activityTracker?.updateStatus(assignment.id, 'Resumed work after approval');
                ctx.assignmentRepo.updateStatus(assignment.id, 'running');
                ctx.onResumed?.();
              }
            } catch {
              // session closed
            }
          })();
        }
      }

      agentResult = await agent.execute(assignment, {
        worktreePath: wt.path,
        task: taskContract,
        assignment,
        originalUserRequest: ctx.originalUserRequest,
        abortSignal,
        logPath,
        timeoutMs: Math.max(1, ctx.config.execution.defaultTimeoutMinutes) * 60_000,
        mutationAllowed,
        runId,
        onActivity: (activity: string) => {
          ctx.activityTracker?.updateStatus(assignment.id, activity);
        },
        onStreamEvent: (event) => {
          ctx.streamBus?.publish(event);
        },
        onEvent: async (event) => {
          if (ctx.interactionGateway && session) {
            if (event.type === 'permission_request') {
              ctx.assignmentRepo.updateStatus(assignment.id, 'waiting_permission');
              ctx.onAttention?.('waiting_permission');
              ctx.activityTracker?.setAttention(assignment.id, {
                type: 'permission',
                prompt: (event as any).prompt || 'Permission approval required',
                resource: (event as any).resource,
                operation: (event as any).operation,
                category: (event as any).category,
                requestId: (event as any).requestId,
              });
            }
            await ctx.interactionGateway.handleEvent(event, session, {
              runId,
              taskId: task.id,
              assignmentId: assignment.id,
              agentId: agent.id,
            });
            ctx.activityTracker?.clearAttention(assignment.id);
            ctx.activityTracker?.updateStatus(assignment.id, 'Resumed work after approval');
            ctx.assignmentRepo.updateStatus(assignment.id, 'running');
            ctx.onResumed?.();
          }
        },
      });
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err));
      agentResult = {
        success: false,
        message: `Adapter error: ${thrownError.message}`,
        durationMs: 0,
      };
    } finally {
      const sessionRegistry = ctx.sessionRegistry ?? ctx.communicationBus?.getSessionRegistry();
      if (sessionRegistry) {
        sessionRegistry.unregister(assignment.id);
      }
      if (ctx.concurrency) {
        ctx.concurrency.release(assignment.id, agent.id, task.id);
      }
      if (session) {
        try {
          await session.close();
        } catch {
          // ignore close error
        }
      }
      try {
        agent.releaseSession?.(assignment.id);
      } catch {
        // ignore release error
      }

      const isCancelled =
        abortSignal?.aborted ||
        agentResult?.message?.includes('cancelled') ||
        agentResult?.message?.includes('aborted');
      const finalExecStatus = isCancelled ? 'cancelled' : agentResult?.success ? 'success' : 'failed';
      const finalAsgnStatus = isCancelled ? 'cancelled' : agentResult?.success ? 'completed' : 'failed';

      try {
        ctx.executionRepo.complete(
          execRecord.id,
          finalExecStatus,
          agentResult?.success ? 0 : 1,
          agentResult?.message ?? thrownError?.message ?? 'Execution error',
        );
      } catch {
        // ignore persistence error
      }

      try {
        ctx.assignmentRepo.updateStatus(
          assignment.id,
          finalAsgnStatus,
          undefined,
          undefined,
          agentResult?.completionReason,
        );
      } catch {
        // ignore persistence error
      }
    }

    // Defense in depth: enforcement inside individual adapters (e.g.
    // BaseCliAdapter) is preferred, but is not guaranteed for every AgentAdapter
    // implementation. Regardless of what the adapter did, a read-only task's
    // worktree must never end up with an uncommitted mutation or a rogue commit
    // ahead of baseCommit -- verify and revert here, at the single chokepoint
    // every execution path (single-agent, collaborative, parallel, review,
    // competitive) runs through.
    if (!mutationAllowed) {
      try {
        const guardGit = new GitService(wt.path);
        const guardStatus = await guardGit.getStatus(wt.path);
        const committedBeyondBase = Boolean(
          agentResult.commitHash && agentResult.commitHash !== baseCommit,
        );
        if (!guardStatus.isClean || committedBeyondBase) {
          ctx.eventRepo.append({
            id: `evt-${randomUUID()}`,
            runId,
            taskId: task.id,
            type: 'MUTATION_BLOCKED',
            payload: {
              taskId: task.id,
              assignmentId: assignment.id,
              agentId: agent.id,
              uncommittedFiles: guardStatus.uncommittedFiles,
              blockedCommit: committedBeyondBase ? agentResult.commitHash : undefined,
            },
            timestamp: new Date(),
          });
          ctx.activityTracker?.updateStatus(
            assignment.id,
            'Blocked by task policy: reverted a repository mutation -- this task is read-only.',
          );
          await guardGit.discardAllChanges(wt.path, baseCommit);
          agentResult.commitHash = baseCommit;
        }
      } catch {
        // best-effort guard; do not fail the task solely because the guard check itself errored
      }
    }

    const resolvedFindings =
      agentResult.findings && agentResult.findings.length > 0
        ? agentResult.findings
        : parseStructuredFindings(agentResult.output) ??
          parseStructuredFindings(agentResult.message);

    if (resolvedFindings && resolvedFindings.length > 0 && ctx.activityTracker) {
      const criticals = resolvedFindings.filter(
        (f) => f.severity === 'critical' || f.severity === 'major',
      );
      if (criticals.length > 0) {
        ctx.activityTracker.setCriticalFindings(assignment.id, criticals);
      }
    }

    ctx.streamBus?.publish({
      type: 'completed',
      timestamp: new Date(),
      runId,
      taskId: task.id,
      assignmentId: assignment.id,
      agentId: agent.id,
      role: assignment.role,
      success: agentResult.success,
      summary: agentResult.message,
    });

    return {
      success: agentResult.success,
      commitHash: agentResult.commitHash,
      output: agentResult.output,
      message: agentResult.message,
      worktreePath: wt.path,
      durationMs: agentResult.durationMs,
      collaborationProposal: agentResult.collaborationProposal,
      findings: resolvedFindings,
      normalizedOutcome: agentResult.normalizedOutcome,
      completionReason: agentResult.completionReason,
    };
  } finally {
    // AgentActivityTracker represents only live assignments. Keeping a
    // completed attempt here makes the cockpit/footer report ghost agents,
    // especially after investigation failover where both the failed attempt
    // and its replacement have distinct assignment IDs.
    ctx.activityTracker?.completeAssignment(assignment.id);
  }
}

export function parseStructuredFindings(
  text?: string,
): import('@taskforge/shared').ReviewFinding[] | undefined {
  if (!text) return undefined;

  const validSeverities = new Set(['critical', 'major', 'minor', 'suggestion']);

  function extract(obj: any): import('@taskforge/shared').ReviewFinding[] | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const list = Array.isArray(obj) ? obj : Array.isArray(obj.findings) ? obj.findings : undefined;
    if (!list || !Array.isArray(list)) return undefined;

    const res: import('@taskforge/shared').ReviewFinding[] = [];
    for (const item of list) {
      if (typeof item === 'object' && item !== null && typeof item.description === 'string') {
        const rawSev = typeof item.severity === 'string' ? item.severity.toLowerCase() : 'minor';
        const sev = validSeverities.has(rawSev) ? rawSev : 'minor';
        const file =
          typeof item.file === 'string'
            ? item.file
            : typeof item.path === 'string'
              ? item.path
              : undefined;
        let line: number | undefined;
        if (typeof item.line === 'number') {
          line = item.line;
        } else if (typeof item.line === 'string') {
          const parsed = parseInt(item.line, 10);
          if (!isNaN(parsed)) line = parsed;
        }
        res.push({
          severity: sev as any,
          description: item.description,
          file,
          line,
        });
      }
    }
    return res.length > 0 ? res : undefined;
  }

  // 1. Check for markdown code blocks
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const res = extract(parsed);
      if (res) return res;
    } catch {
      // continue
    }
  }

  // 2. Check for raw JSON object { ... }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      const res = extract(parsed);
      if (res) return res;
    } catch {
      // continue
    }
  }

  // 3. Check for raw JSON array [ ... ]
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
      const res = extract(parsed);
      if (res) return res;
    } catch {
      // continue
    }
  }

  return undefined;
}
