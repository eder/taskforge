import {
  AgentMessage,
  AgentRuntimeEvent,
  AgentSession,
  InteractionResponse,
} from '@taskforge/shared';

export class FakeAgentSession implements AgentSession {
  public readonly sessionId: string;
  public readonly assignmentId: string;
  private eventQueue: AgentRuntimeEvent[] = [];
  private eventWaiters: Array<() => void> = [];
  private responseResolvers: Map<string, (resp: InteractionResponse) => void> = new Map();
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
    }
  }

  public waitForResponse(requestId: string): Promise<InteractionResponse> {
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
  }
}

export interface RealCliSessionOptions {
  adapterId?: string;
  adapterName?: string;
  taskId?: string;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

export class RealCliAgentSession implements AgentSession {
  public readonly sessionId: string;
  public readonly assignmentId: string;
  private child?: import('node:child_process').ChildProcess;
  private eventQueue: AgentRuntimeEvent[] = [];
  private eventWaiters: Array<() => void> = [];
  private responseResolvers: Map<string, (resp: InteractionResponse) => void> = new Map();
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
    return new Promise((resolve) => {
      this.responseResolvers.set(requestId, resolve);
    });
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
            this.pushEvent({
              id: reqId,
              type: 'permission_request',
              category: obj.category || 'commands',
              operation: obj.operation || obj.command || 'execute',
              resource: obj.resource || obj.path,
              prompt: obj.prompt || 'Permission requested by agent',
              timestamp: new Date(),
            } as any);
            return;
          }

          if (obj.type === 'question' || obj.event === 'question' || obj.type === 'ask_user') {
            const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            this.pendingRequestId = reqId;
            this.pushEvent({
              id: reqId,
              type: 'question',
              prompt: obj.question || obj.prompt || 'Agent requested input',
              options: obj.options,
              timestamp: new Date(),
            } as any);
            return;
          }

          if (obj.type === 'authentication_required' || obj.event === 'auth_required') {
            const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            this.pendingRequestId = reqId;
            this.pushEvent({
              id: reqId,
              type: 'authentication_required',
              service: obj.service || 'unknown',
              prompt: obj.prompt || 'Authentication required',
              timestamp: new Date(),
            } as any);
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
      } else {
        // 2. Fallback terminal prompt detection for interactive CLI queries
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
        this.pushEvent({
          id: reqId,
          type: 'permission_request',
          category: 'commands',
          operation: 'bash',
          resource: cmd,
          prompt: `Agent requested permission to execute command: "${cmd}"`,
          timestamp: new Date(),
        } as any);
      }
    }
  }

  private detectTerminalPrompt(line: string): void {
    const stripped = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!stripped) return;

    if (
      /\((?:y\/n|yes\/no|y\/N)\)/i.test(stripped) ||
      /(?:approve|proceed|allow|execute|confirm)\s*\?/i.test(stripped) ||
      /Do you want to (?:proceed|continue|run)/i.test(stripped)
    ) {
      if (this.pendingRequestId) return;
      const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      this.pendingRequestId = reqId;
      this.pushEvent({
        id: reqId,
        type: 'permission_request',
        category: 'commands',
        operation: 'interactive_prompt',
        resource: stripped,
        prompt: stripped,
        timestamp: new Date(),
      } as any);
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
      } catch {}
    }
  }
}

export { RealCliAgentSession as CliAgentSession };

