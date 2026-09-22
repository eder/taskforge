import {
  AgentMessage,
  AgentRuntimeEvent,
  AgentSession,
  InteractionResponse,
  PermissionRequestEvent,
  AgentQuestionEvent,
  AuthenticationRequiredEvent,
} from '@taskforge/shared';

export class FakeAgentSession implements AgentSession {
  public readonly sessionId: string;
  public readonly assignmentId: string;
  private eventQueue: AgentRuntimeEvent[] = [];
  private eventWaiters: Array<() => void> = [];
  private responseResolvers: Map<string, (resp: InteractionResponse) => void> = new Map();
  private bufferedResponses: Map<string, InteractionResponse> = new Map();
  public messages: (AgentMessage | string)[] = [];
  public isCancelled = false;

  constructor(sessionId: string, assignmentId: string) {
    this.sessionId = sessionId;
    this.assignmentId = assignmentId;
  }

  public pushEvent(event: AgentRuntimeEvent): void {
    this.eventQueue.push(event);
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter();
  }

  public async *events(): AsyncIterable<AgentRuntimeEvent> {
    while (!this.isCancelled) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          this.eventWaiters.push(resolve);
        });
      }
    }
  }

  public async send(message: AgentMessage | string): Promise<void> {
    this.messages.push(message);
  }

  public async respond(response: InteractionResponse): Promise<void> {
    const resolver = this.responseResolvers.get(response.requestId);
    if (resolver) {
      this.responseResolvers.delete(response.requestId);
      resolver(response);
    } else {
      this.bufferedResponses.set(response.requestId, response);
    }
  }

  public waitForResponse(requestId: string): Promise<InteractionResponse> {
    if (this.bufferedResponses.has(requestId)) {
      const resp = this.bufferedResponses.get(requestId)!;
      this.bufferedResponses.delete(requestId);
      return Promise.resolve(resp);
    }
    return new Promise((resolve) => {
      this.responseResolvers.set(requestId, resolve);
    });
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    for (const waiter of this.eventWaiters) {
      waiter();
    }
    this.eventWaiters = [];
    for (const [reqId, resolver] of this.responseResolvers.entries()) {
      resolver({
        id: `resp-cancel-${Date.now()}`,
        requestId: reqId,
        decision: 'cancel',
        source: 'policy',
        scope: 'once',
        createdAt: new Date().toISOString(),
      });
    }
    this.responseResolvers.clear();
  }

  public async close(): Promise<void> {
    this.isCancelled = true;
    for (const waiter of this.eventWaiters) {
      waiter();
    }
    this.eventWaiters = [];
    for (const [reqId, resolver] of this.responseResolvers.entries()) {
      resolver({
        id: `resp-cancel-${Date.now()}`,
        requestId: reqId,
        decision: 'cancel',
        source: 'policy',
        scope: 'once',
        createdAt: new Date().toISOString(),
      });
    }
    this.responseResolvers.clear();
  }
}

export interface RealCliSessionOptions {
  adapterId?: string;
  adapterName?: string;
  taskId?: string;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
  /**
   * Legacy escape hatch for CLIs that do not expose structured interaction
   * events. Supported TaskForge adapters use structured/provider-native
   * protocols and explicitly disable this heuristic so command/search output
   * can never be mistaken for a human prompt.
   */
  rawTerminalPromptFallback?: boolean;
}

export class RealCliAgentSession implements AgentSession {
  public readonly sessionId: string;
  public readonly assignmentId: string;
  private child?: import('node:child_process').ChildProcess;
  private eventQueue: AgentRuntimeEvent[] = [];
  private eventWaiters: Array<() => void> = [];
  private responseResolvers: Map<string, (resp: InteractionResponse) => void> = new Map();
  private bufferedResponses: Map<string, InteractionResponse> = new Map();
  public messages: (AgentMessage | string)[] = [];
  public isCancelled = false;
  private options?: RealCliSessionOptions;
  private pendingRequestId?: string;

  constructor(sessionId: string, assignmentId: string, options?: RealCliSessionOptions) {
    this.sessionId = sessionId;
    this.assignmentId = assignmentId;
    this.options = options;
  }

  public attachProcess(child: import('node:child_process').ChildProcess): void {
    this.child = child;
  }

  public pushEvent(event: AgentRuntimeEvent): void {
    this.eventQueue.push(event);
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter();
    this.options?.onEvent?.(event);
  }

  public async *events(): AsyncIterable<AgentRuntimeEvent> {
    while (!this.isCancelled) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          this.eventWaiters.push(resolve);
        });
      }
    }
  }

  public async send(message: AgentMessage | string): Promise<void> {
    this.messages.push(message);
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (this.child?.stdin && !this.child.stdin.destroyed) {
      this.child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
    }
  }

  public async respond(response: InteractionResponse): Promise<void> {
    const resolver = this.responseResolvers.get(response.requestId);
    if (resolver) {
      this.responseResolvers.delete(response.requestId);
      resolver(response);
    } else {
      this.bufferedResponses.set(response.requestId, response);
    }
    if (this.pendingRequestId === response.requestId) {
      this.pendingRequestId = undefined;
    }

    if (this.child?.stdin && !this.child.stdin.destroyed) {
      if (response.payload !== undefined && response.payload !== null) {
        const text = String(response.payload);
        this.child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
      } else if (response.decision === 'allow') {
        this.child.stdin.write('y\n');
      } else if (response.decision === 'deny' || response.decision === 'cancel') {
        this.child.stdin.write('n\n');
      }
    }
  }

  public waitForResponse(requestId: string): Promise<InteractionResponse> {
    if (this.bufferedResponses.has(requestId)) {
      const resp = this.bufferedResponses.get(requestId)!;
      this.bufferedResponses.delete(requestId);
      return Promise.resolve(resp);
    }
    return new Promise((resolve) => {
      this.responseResolvers.set(requestId, resolve);
    });
  }

  private createBaseEvent(): {
    sessionId: string;
    assignmentId: string;
    agentId: string;
    timestamp: string;
  } {
    return {
      sessionId: this.sessionId,
      assignmentId: this.assignmentId,
      agentId: this.options?.adapterId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
  }

  public handleOutputChunk(chunk: string, _stream: 'stdout' | 'stderr'): void {
    const lines = chunk.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 1. Structured JSON events
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const obj = JSON.parse(trimmed);

          // Explicit permission / question / auth from JSON protocols
          if (obj.type === 'permission_request' || obj.event === 'permission_request') {
            const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            this.pendingRequestId = reqId;
            const event: PermissionRequestEvent = {
              ...this.createBaseEvent(),
              type: 'permission_request',
              requestId: reqId,
              category: obj.category || 'commands',
              operation: obj.operation || obj.command || 'execute',
              resource: obj.resource || obj.path || '',
              prompt: obj.prompt || 'Permission requested by agent',
            };
            this.pushEvent(event);
            return;
          }

          if (obj.type === 'question' || obj.event === 'question' || obj.type === 'ask_user') {
            const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            this.pendingRequestId = reqId;
            const event: AgentQuestionEvent = {
              ...this.createBaseEvent(),
              type: 'question',
              requestId: reqId,
              prompt: obj.question || obj.prompt || 'Agent requested input',
              options: Array.isArray(obj.options) ? obj.options : undefined,
            };
            this.pushEvent(event);
            return;
          }

          if (obj.type === 'authentication_required' || obj.event === 'auth_required') {
            const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            this.pendingRequestId = reqId;
            const event: AuthenticationRequiredEvent = {
              ...this.createBaseEvent(),
              type: 'authentication_required',
              requestId: reqId,
              service: obj.service || 'unknown',
              prompt: obj.prompt || 'Authentication required',
            };
            this.pushEvent(event);
            return;
          }

          // Tool use in Claude Code / Antigravity / Codex stream
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const item of obj.message.content) {
              if (item.type === 'tool_use') {
                this.inspectToolUse(item.name, item.input);
              }
            }
          }
          if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
            this.inspectToolUse(obj.content_block.name, obj.content_block.input);
          }
        } catch {
          // ignore json parse error
        }
      } else if (this.options?.rawTerminalPromptFallback !== false) {
        // 2. Legacy fallback terminal-prompt detection. Real TaskForge
        // adapters with structured/provider-native interaction protocols
        // disable this path explicitly; otherwise arbitrary command output
        // (grep/rg/test logs containing prompt-like strings) could create a
        // fake ACTION REQUIRED interaction.
        this.detectTerminalPrompt(trimmed);
      }
    }
  }

  private inspectToolUse(toolName: string, input?: Record<string, unknown>): void {
    if (!input) return;

    if (toolName === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command.trim();
      const lower = cmd.toLowerCase();
      if (
        lower.startsWith('sudo ') ||
        lower.includes('npm install') ||
        lower.includes('pnpm add') ||
        lower.includes('yarn add') ||
        lower.includes('git push') ||
        lower.includes('rm -rf') ||
        lower.includes('curl ') ||
        lower.includes('wget ')
      ) {
        const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        this.pendingRequestId = reqId;
        const event: PermissionRequestEvent = {
          ...this.createBaseEvent(),
          type: 'permission_request',
          requestId: reqId,
          category: 'commands',
          operation: 'bash',
          resource: cmd,
          prompt: `Agent requested permission to execute command: "${cmd}"`,
        };
        this.pushEvent(event);
      }
    }
  }

  private detectTerminalPrompt(line: string): void {
    // eslint-disable-next-line no-control-regex
    const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!stripped) return;

    // Raw fallback detection must be intentionally high-confidence. It is
    // designed only for a real terminal question from a legacy CLI, not for
    // source code, grep output, test snapshots, logs, or escaped command
    // output that merely contains prompt-like text.
    if (stripped.length > 512 || stripped.includes('\\n') || /:\d+(?::\d+)?:/.test(stripped)) {
      return;
    }

    const looksLikePrompt =
      /^(?:do you want to (?:proceed|continue|run|execute|allow)\b.{0,320}|(?:approve|proceed|allow|execute|confirm)\b.{0,320}\?|.{0,320}\((?:y\/n|yes\/no|y\/N|Y\/n)\))\s*$/i.test(
        stripped,
      );

    if (looksLikePrompt) {
      if (this.pendingRequestId) return;
      const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      this.pendingRequestId = reqId;
      const event: PermissionRequestEvent = {
        ...this.createBaseEvent(),
        type: 'permission_request',
        requestId: reqId,
        category: 'commands',
        operation: 'interactive_prompt',
        resource: stripped,
        prompt: stripped,
      };
      this.pushEvent(event);
    }
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    for (const waiter of this.eventWaiters) {
      waiter();
    }
    this.eventWaiters = [];
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore error on kill
      }
    }
  }

  /** Called after the assignment's process has already exited normally; only stops the event loop. */
  public async close(): Promise<void> {
    this.isCancelled = true;
    for (const waiter of this.eventWaiters) {
      waiter();
    }
    this.eventWaiters = [];
  }
}

export { RealCliAgentSession as CliAgentSession };

