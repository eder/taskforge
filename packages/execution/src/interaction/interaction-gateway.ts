import {
  AgentRuntimeEvent,
  AgentSession,
  InteractionRequest,
  InteractionResponse,
  InteractionScope,
  TaskForgeConfig,
} from '@taskforge/shared';
import { InteractionRepository } from '@taskforge/persistence';
import { PermissionEngine } from './permission-engine.js';
import { QuestionRouter } from './question-router.js';

export interface InteractionHandlerContext {
  runId: string;
  taskId: string;
  assignmentId: string;
  agentId: string;
  isHeadless?: boolean;
}

export type InteractionListener = (request: InteractionRequest) => void;

interface PendingPromise {
  request: InteractionRequest;
  resolve: (response: InteractionResponse) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class InteractionGateway {
  private permissionEngine: PermissionEngine;
  private questionRouter: QuestionRouter;
  private interactionRepo?: InteractionRepository;
  private config: TaskForgeConfig;
  private pendingInteractions: Map<string, PendingPromise> = new Map();
  private listeners: Set<InteractionListener> = new Set();

  constructor(options: {
    config?: TaskForgeConfig;
    permissionEngine?: PermissionEngine;
    questionRouter?: QuestionRouter;
    interactionRepo?: InteractionRepository;
  } = {}) {
    this.config = options.config ?? ({
      permissions: {
        filesystem: { workspace_write: 'allow', outside_workspace: 'ask_human', delete_files: 'ask_human' },
        commands: { tests: 'allow', lint: 'allow', package_install: 'ask_human', network: 'ask_human', sudo: 'deny' },
        git: { commit: 'allow', push: 'ask_human', force_push: 'deny', merge_main: 'deny' },
        fallback: 'ask_human',
      },
      headless: {
        onHumanQuestion: 'block',
        onUnknownPermission: 'deny',
        onAuthenticationRequired: 'fail',
        onConfirmationRequired: 'block',
      },
      interactions: {
        humanResponseTimeout: 1800000,
        onTimeout: { permission: 'deny', question: 'block', confirmation: 'block' },
      },
    } as unknown as TaskForgeConfig);

    this.interactionRepo = options.interactionRepo;
    this.permissionEngine = options.permissionEngine ?? new PermissionEngine(this.config.permissions, this.interactionRepo);
    this.questionRouter = options.questionRouter ?? new QuestionRouter(this.permissionEngine);
  }

  public onInteraction(listener: InteractionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async handleEvent(
    event: AgentRuntimeEvent,
    session: AgentSession,
    ctx: InteractionHandlerContext,
  ): Promise<void> {
    const isHeadless = ctx.isHeadless ?? (this.config.ui?.mode === 'headless');

    switch (event.type) {
      case 'permission_request': {
        const decision = this.permissionEngine.evaluate({
          category: event.category,
          operation: event.operation,
          resource: event.resource,
          taskId: ctx.taskId,
          runId: ctx.runId,
        });

        if (decision === 'allow') {
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: 'allow',
            source: 'policy',
            scope: 'task',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        if (decision === 'deny') {
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: 'deny',
            source: 'policy',
            scope: 'task',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // decision is 'ask_human'
        if (isHeadless) {
          const fallback = this.config.headless.onUnknownPermission;
          if (fallback === 'allow') {
            await session.respond({
              id: `resp-${Date.now()}`,
              requestId: event.requestId,
              decision: 'allow',
              source: 'policy',
              scope: 'once',
              createdAt: new Date().toISOString(),
            });
            return;
          }
          // Default headless: deny without hanging
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: 'deny',
            source: 'policy',
            scope: 'once',
            payload: 'Denied automatically by headless policy',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // Interactive mode: queue request and wait
        await this.queueInteractionAndWait(
          {
            id: event.requestId,
            runId: ctx.runId,
            taskId: ctx.taskId,
            assignmentId: ctx.assignmentId,
            agentId: ctx.agentId,
            type: 'permission',
            prompt: event.prompt,
            category: event.category,
            resource: event.resource,
            status: 'pending',
            priority: 'normal',
            timeoutMs: typeof this.config.interactions.humanResponseTimeout === 'number'
              ? this.config.interactions.humanResponseTimeout
              : 1800000,
            createdAt: new Date().toISOString(),
          },
          session,
          'permission',
        );
        break;
      }

      case 'question': {
        const routeResult = this.questionRouter.route({
          prompt: event.prompt,
          options: event.options,
          taskId: ctx.taskId,
          runId: ctx.runId,
        });

        if (routeResult.outcome === 'AUTO_RESOLVE' && routeResult.answer) {
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: 'answer',
            payload: routeResult.answer,
            source: 'context',
            scope: 'task',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        if (routeResult.outcome === 'POLICY_DENY') {
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: 'deny',
            payload: routeResult.reason,
            source: 'policy',
            scope: 'task',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        if (routeResult.outcome === 'POLICY_ALLOW') {
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: 'allow',
            payload: routeResult.answer,
            source: 'policy',
            scope: 'task',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        if (routeResult.outcome === 'BLOCK') {
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: 'cancel',
            payload: routeResult.reason,
            source: 'policy',
            scope: 'task',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // ASK_HUMAN
        if (isHeadless) {
          const action = this.config.headless.onHumanQuestion;
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: action === 'fail' ? 'cancel' : 'deny',
            payload: `Cannot ask human in headless mode (onHumanQuestion=${action})`,
            source: 'policy',
            scope: 'once',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        await this.queueInteractionAndWait(
          {
            id: event.requestId,
            runId: ctx.runId,
            taskId: ctx.taskId,
            assignmentId: ctx.assignmentId,
            agentId: ctx.agentId,
            type: 'question',
            prompt: event.prompt,
            status: 'pending',
            priority: 'normal',
            timeoutMs: typeof this.config.interactions.humanResponseTimeout === 'number'
              ? this.config.interactions.humanResponseTimeout
              : 1800000,
            createdAt: new Date().toISOString(),
          },
          session,
          'question',
        );
        break;
      }

      case 'confirmation_request': {
        if (isHeadless) {
          const action = this.config.headless.onConfirmationRequired;
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: action === 'block' ? 'deny' : 'cancel',
            payload: `Confirmation denied in headless mode`,
            source: 'policy',
            scope: 'once',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        await this.queueInteractionAndWait(
          {
            id: event.requestId,
            runId: ctx.runId,
            taskId: ctx.taskId,
            assignmentId: ctx.assignmentId,
            agentId: ctx.agentId,
            type: 'confirmation',
            prompt: event.prompt,
            status: 'pending',
            priority: 'normal',
            timeoutMs: 1800000,
            createdAt: new Date().toISOString(),
          },
          session,
          'confirmation',
        );
        break;
      }

      case 'authentication_required': {
        if (isHeadless) {
          const action = this.config.headless.onAuthenticationRequired;
          await session.respond({
            id: `resp-${Date.now()}`,
            requestId: event.requestId,
            decision: action === 'fail' ? 'cancel' : 'deny',
            payload: `Authentication required but unavailable in headless mode`,
            source: 'policy',
            scope: 'once',
            createdAt: new Date().toISOString(),
          });
          return;
        }

        await this.queueInteractionAndWait(
          {
            id: event.requestId,
            runId: ctx.runId,
            taskId: ctx.taskId,
            assignmentId: ctx.assignmentId,
            agentId: ctx.agentId,
            type: 'auth',
            prompt: event.prompt,
            status: 'pending',
            priority: 'urgent',
            timeoutMs: 1800000,
            createdAt: new Date().toISOString(),
          },
          session,
          'permission',
        );
        break;
      }

      default:
        // Other events (output, status, completed, error) do not pause the session
        break;
    }
  }

  private async queueInteractionAndWait(
    request: InteractionRequest,
    session: AgentSession,
    timeoutKind: 'permission' | 'question' | 'confirmation',
  ): Promise<void> {
    if (this.interactionRepo) {
      this.interactionRepo.createRequest(request);
    }

    // Notify registered UI / shell listeners
    for (const listener of this.listeners) {
      try {
        listener(request);
      } catch {
        // ignore listener errors
      }
    }

    const response = await new Promise<InteractionResponse>((resolve, reject) => {
      const timeoutMs = request.timeoutMs ?? 1800000;
      let timer: NodeJS.Timeout | undefined;

      if (timeoutMs > 0 && timeoutMs < 86400000) {
        timer = setTimeout(() => {
          this.pendingInteractions.delete(request.id);
          if (this.interactionRepo) {
            this.interactionRepo.updateRequestStatus(request.id, 'timed_out');
          }
          const defaultDecision = this.config.interactions.onTimeout[timeoutKind];
          resolve({
            id: `resp-timeout-${Date.now()}`,
            requestId: request.id,
            decision: defaultDecision === 'allow' ? 'allow' : 'deny',
            payload: `Timed out after ${timeoutMs}ms`,
            source: 'policy',
            scope: 'once',
            createdAt: new Date().toISOString(),
          });
        }, timeoutMs);
      }

      this.pendingInteractions.set(request.id, {
        request,
        resolve,
        reject,
        timer,
      });
    });

    await session.respond(response);
  }

  public resolve(
    requestId: string,
    decision: 'allow' | 'deny' | 'answer' | 'cancel',
    payload?: string,
    scope: InteractionScope = 'task',
    responderId: string = 'human',
  ): boolean {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) {
      if (this.interactionRepo) {
        const req = this.interactionRepo.getRequest(requestId);
        if (req && req.status === 'pending') {
          const response: InteractionResponse = {
            id: `resp-${Date.now()}`,
            requestId,
            decision,
            payload,
            source: responderId === 'policy' ? 'policy' : 'human',
            scope,
            responderId,
            createdAt: new Date().toISOString(),
          };
          this.interactionRepo.createResponse(response);
          this.interactionRepo.updateRequestStatus(
            requestId,
            decision === 'deny' || decision === 'cancel' ? 'denied' : 'resolved',
          );
          if (decision === 'allow' && req.category && req.resource) {
            this.permissionEngine.recordApproval(
              req.category,
              req.resource,
              'allow',
              scope,
              req.taskId,
              req.runId,
            );
          }
          return true;
        }
      }
      return false;
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    this.pendingInteractions.delete(requestId);

    const response: InteractionResponse = {
      id: `resp-${Date.now()}`,
      requestId,
      decision,
      payload,
      source: responderId === 'policy' ? 'policy' : 'human',
      scope,
      responderId,
      createdAt: new Date().toISOString(),
    };

    if (this.interactionRepo) {
      this.interactionRepo.createResponse(response);
      this.interactionRepo.updateRequestStatus(
        requestId,
        decision === 'deny' || decision === 'cancel' ? 'denied' : 'resolved',
      );
    }

    // If permission was allowed and had category/resource, remember approval
    if (decision === 'allow' && pending.request.category && pending.request.resource) {
      this.permissionEngine.recordApproval(
        pending.request.category,
        pending.request.resource,
        'allow',
        scope,
        pending.request.taskId,
        pending.request.runId,
      );
    }

    pending.resolve(response);
    return true;
  }

  public getPendingRequests(runId?: string): InteractionRequest[] {
    const active = Array.from(this.pendingInteractions.values()).map((p) => p.request);
    if (active.length > 0) {
      if (runId) {
        return active.filter((r) => r.runId === runId);
      }
      return active;
    }
    if (this.interactionRepo) {
      return this.interactionRepo.getPendingRequests(runId);
    }
    return [];
  }

  public cancelAll(): void {
    for (const [id, pending] of this.pendingInteractions.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({
        id: `resp-cancel-${Date.now()}`,
        requestId: id,
        decision: 'cancel',
        payload: 'Interaction cancelled',
        source: 'policy',
        scope: 'once',
        createdAt: new Date().toISOString(),
      });
    }
    this.pendingInteractions.clear();
  }
}
