import { randomUUID } from 'node:crypto';
import { AgentMessage, CollaborationLimitError } from '@taskforge/shared';
import { TaskForgeDatabase, EventRepository } from '@taskforge/persistence';
import { AgentAdapter } from '@taskforge/agents';
import { SessionRegistry } from './session-registry.js';

export interface BusOptions {
  maxMessagesPerRound?: number;
  maxRounds?: number;
  sessionRegistry?: SessionRegistry;
}

export class CommunicationBus {
  private messageCount = 0;
  private currentRound = 1;
  private taskAgents: Map<string, Set<string>> = new Map();
  private agentAdapters: Map<string, AgentAdapter> = new Map();
  private sessionRegistry?: SessionRegistry;

  constructor(
    private db?: TaskForgeDatabase,
    private eventRepo?: EventRepository,
    private options: BusOptions = {},
    sessionRegistry?: SessionRegistry,
  ) {
    this.sessionRegistry = sessionRegistry ?? options.sessionRegistry;
  }

  setSessionRegistry(registry: SessionRegistry): void {
    this.sessionRegistry = registry;
  }

  getSessionRegistry(): SessionRegistry | undefined {
    return this.sessionRegistry;
  }

  registerAgent(assignmentId: string, adapter: AgentAdapter): void {
    this.agentAdapters.set(assignmentId, adapter);
  }

  async sendMessage(message: Omit<AgentMessage, 'id' | 'createdAt'>): Promise<AgentMessage> {
    const maxMessages = this.options.maxMessagesPerRound ?? 6;
    const maxRounds = this.options.maxRounds ?? 3;

    if (this.currentRound > maxRounds) {
      throw new CollaborationLimitError(
        `Communication exceeded maximum allowed rounds (${maxRounds}) for task ${message.taskId}`,
        { taskId: message.taskId, round: this.currentRound, maxRounds },
      );
    }

    if (this.messageCount >= maxMessages) {
      this.currentRound += 1;
      this.messageCount = 0;
      if (this.currentRound > maxRounds) {
        throw new CollaborationLimitError(
          `Communication exceeded maximum allowed rounds (${maxRounds}) for task ${message.taskId}`,
          { taskId: message.taskId, round: this.currentRound, maxRounds },
        );
      }
    }

    this.messageCount += 1;

    const fullMessage: AgentMessage = {
      ...message,
      id: `msg-${randomUUID()}`,
      createdAt: new Date(),
    };

    // 1. Persist to DB
    if (this.db) {
      const now = fullMessage.createdAt.toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO tasks (
            id, run_id, goal_id, title, description, type, status,
            contract_json, rework_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fullMessage.taskId,
          fullMessage.runId,
          'goal-default',
          fullMessage.taskId,
          'Collaborative task',
          'investigation',
          'running',
          JSON.stringify({
            objective: 'Collaborative work',
            allowedScope: ['*'],
            forbiddenChanges: [],
            acceptanceCriteria: [],
            dependencies: [],
          }),
          0,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO agent_messages (
            id, run_id, task_id, from_assignment_id, to_assignment_id,
            type, body, artifact_refs_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fullMessage.id,
          fullMessage.runId,
          fullMessage.taskId,
          fullMessage.fromAssignmentId,
          fullMessage.toAssignmentId ?? null,
          fullMessage.type,
          fullMessage.body,
          fullMessage.artifactRefs ? JSON.stringify(fullMessage.artifactRefs) : null,
          fullMessage.createdAt.toISOString(),
        );
    }

    // 2. Emit event
    if (this.eventRepo) {
      this.eventRepo.append({
        id: `evt-${randomUUID()}`,
        runId: fullMessage.runId,
        taskId: fullMessage.taskId,
        type: 'AGENT_MESSAGE_SENT',
        payload: {
          messageId: fullMessage.id,
          from: fullMessage.fromAssignmentId,
          to: fullMessage.toAssignmentId,
          type: fullMessage.type,
          round: this.currentRound,
        },
        timestamp: new Date(),
      });
    }

    // 3. Deliver to target agent if available
    if (fullMessage.toAssignmentId) {
      const sessionEntry = this.sessionRegistry?.getByAssignment(fullMessage.toAssignmentId);
      if (sessionEntry && sessionEntry.adapter.send) {
        await sessionEntry.adapter.send(sessionEntry.sessionId, fullMessage);
      } else {
        const recipient = this.agentAdapters.get(fullMessage.toAssignmentId);
        if (recipient && recipient.send) {
          await recipient.send(fullMessage.toAssignmentId, fullMessage);
        }
      }
    }

    return fullMessage;
  }

  getRound(): number {
    return this.currentRound;
  }

  reset(): void {
    this.messageCount = 0;
    this.currentRound = 1;
    this.taskAgents.clear();
    this.agentAdapters.clear();
  }
}
