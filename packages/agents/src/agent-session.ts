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

export class CliAgentSession implements AgentSession {
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
