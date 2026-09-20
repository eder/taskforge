import { AgentRole, CollaborationMode, RepositoryProfile } from '@taskforge/shared';
import { Task } from '@taskforge/core';

export interface RoleRequest {
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
  roles: RoleRequest[];
  communication: {
    required: boolean;
    initialAlignment: boolean;
    synthesisBeforeImplementation: boolean;
  };
  reason: string;
  /**
   * How a concurrent (parallel/competitive) team handles investigator failures.
   * Defaults to 'all_required' when omitted: any failed investigator aborts
   * the team before synthesis/implementation runs.
   */
  investigationPolicy?: 'all_required' | 'quorum' | 'best_effort';
}

export interface RoutingInput {
  task: Task;
  repository?: RepositoryProfile;
  signals?: {
    complexity?: 'low' | 'medium' | 'high';
    risk?: 'low' | 'medium' | 'high';
    uncertainty?: 'low' | 'medium' | 'high';
  };
  availableAgents: string[];
  budgetPreference?: 'cost' | 'balanced' | 'quality';
}

export interface RoutingProvider {
  readonly id: string;
  route(input: RoutingInput): Promise<RoutingDecision>;
}
