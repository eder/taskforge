import { AgentRole, CollaborationMode, RepositoryProfile } from '@taskforge/shared';
import { Task } from '@taskforge/core';

export type RoutingSource = 'openai' | 'static' | 'adaptive' | 'fallback';

export type RouterFallbackReason =
  | 'timeout'
  | 'http_error'
  | 'invalid_schema'
  | 'empty_response'
  | 'provider_unavailable'
  | 'quota'
  | 'unknown';

export interface PolicyAdjustment {
  originalComplexity: 'low' | 'medium' | 'high';
  adjustedComplexity: 'low' | 'medium' | 'high';
  originalRisk: 'low' | 'medium' | 'high';
  adjustedRisk: 'low' | 'medium' | 'high';
  reasons: string[];
  crossCuttingRuntimeUpgrade?: boolean;
}

export interface RouterProposal {
  strategy: CollaborationMode;
  complexity: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
}

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
  investigationPolicy?: 'all_required' | 'quorum' | 'best_effort';

  // Provenance
  source: RoutingSource;
  provider?: string;
  model?: string;
  fallbackReason?: RouterFallbackReason;
  promptVersion?: string;
  contextHash?: string;

  // Quality Guard Adjustments
  routerProposal?: RouterProposal;
  policyAdjustment?: PolicyAdjustment;

  // Provenance grouping
  provenance?: {
    source: RoutingSource;
    provider?: string;
    model?: string;
    fallbackReason?: RouterFallbackReason;
    routerProposal?: RouterProposal;
    policyAdjustment?: PolicyAdjustment;
  };
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
