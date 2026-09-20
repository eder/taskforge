export abstract class TaskForgeError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigurationError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', context);
  }
}

export class RepositoryError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'REPOSITORY_ERROR', context);
  }
}

export class AgentUnavailableError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'AGENT_UNAVAILABLE_ERROR', context);
  }
}

export class AgentExecutionError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'AGENT_EXECUTION_ERROR', context);
  }
}

export class RouterUnavailableError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'ROUTER_UNAVAILABLE_ERROR', context);
  }
}

export class RoutingDecisionError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'ROUTING_DECISION_ERROR', context);
  }
}

export class PlanningError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PLANNING_ERROR', context);
  }
}

export class InvalidTaskGraphError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'INVALID_TASK_GRAPH_ERROR', context);
  }
}

export class TaskNegotiationError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'TASK_NEGOTIATION_ERROR', context);
  }
}

export class WorkspaceCreationError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'WORKSPACE_CREATION_ERROR', context);
  }
}

export class CollaborationLimitError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'COLLABORATION_LIMIT_ERROR', context);
  }
}

export class VerificationError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VERIFICATION_ERROR', context);
  }
}

export class ReviewError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'REVIEW_ERROR', context);
  }
}

export class IntegrationError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'INTEGRATION_ERROR', context);
  }
}

export class DeliveryError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DELIVERY_ERROR', context);
  }
}

export class PluginError extends TaskForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PLUGIN_ERROR', context);
  }
}
