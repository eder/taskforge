import {
  RepositoryProfile,
  TaskPreflightResult,
  AgentRole,
  CollaborationMode,
} from '@taskforge/shared';
import { Goal, Task } from './models.js';
import { TaskGraph } from './task-graph.js';

export interface Planner {
  plan(goal: Goal, profile?: RepositoryProfile): Promise<TaskGraph>;
}

export interface RoutingRoleRequest {
  role: AgentRole;
  requiredCapabilities: string[];
  objective: string;
  preferredAgent?: string;
}

export interface RoutingDecision {
  strategy: CollaborationMode;
  complexity: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  uncertainty: 'low' | 'medium' | 'high';
  teamSize: number;
  roles: RoutingRoleRequest[];
  reason: string;
}

export interface Router {
  route(task: Task, context: unknown): Promise<RoutingDecision>;
}

export interface Negotiator {
  negotiatePreflight(task: Task): Promise<TaskPreflightResult>;
}
