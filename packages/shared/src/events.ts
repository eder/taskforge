export type EventType =
  | 'RUN_CREATED'
  | 'GOAL_UPDATED'
  | 'PLAN_PROPOSED'
  | 'TASK_PREFLIGHT_STARTED'
  | 'TASK_CHALLENGED'
  | 'TASK_ACCEPTED'
  | 'TASK_COLLABORATION_RECOMMENDED'
  | 'TASK_SPLIT_RECOMMENDED'
  | 'ROUTING_REQUESTED'
  | 'ROUTING_DECIDED'
  | 'ASSIGNMENT_CREATED'
  | 'AGENT_MESSAGE_SENT'
  | 'COLLABORATION_ESCALATED'
  | 'TASK_STARTED'
  | 'TASK_COMPLETED'
  | 'VERIFY_STARTED'
  | 'VERIFY_COMPLETED'
  | 'REVIEW_COMPLETED'
  | 'INTEGRATION_COMPLETED';

export interface TaskForgeEvent {
  id: string;
  runId: string;
  taskId?: string;
  type: EventType;
  payload: Record<string, unknown>;
  timestamp: Date;
}
