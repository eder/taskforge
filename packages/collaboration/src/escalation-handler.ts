import { randomUUID } from 'node:crypto';
import { CollaborationProposal } from '@taskforge/shared';
import { EventRepository } from '@taskforge/persistence';

export interface EscalationContext {
  runId: string;
  taskId: string;
  workerAgentId: string;
  proposal: CollaborationProposal;
}

export class EscalationHandler {
  constructor(private eventRepo?: EventRepository) {}

  handleEscalation(ctx: EscalationContext): void {
    if (this.eventRepo) {
      this.eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId: ctx.runId,
        taskId: ctx.taskId,
        type: 'COLLABORATION_ESCALATED',
        payload: {
          initiator: ctx.workerAgentId,
          reason: ctx.proposal.reason,
          requestedRoles: ctx.proposal.requestedRoles,
          urgency: ctx.proposal.urgency,
          expectedBenefit: ctx.proposal.expectedBenefit,
        },
        timestamp: new Date(),
      });
    }
  }
}
