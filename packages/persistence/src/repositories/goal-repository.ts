import { TaskForgeDatabase } from '../database.js';

export interface GoalRecord {
  id: string;
  description: string;
  repository: string;
  constraintsJson?: string;
  acceptanceCriteriaJson?: string;
  createdAt: string;
}

export class GoalRepository {
  constructor(private db: TaskForgeDatabase) {}

  create(goal: {
    id: string;
    description: string;
    repository: string;
    constraints?: unknown[];
    acceptanceCriteria?: string[];
  }): GoalRecord {
    const now = new Date().toISOString();
    const constraintsJson = goal.constraints ? JSON.stringify(goal.constraints) : null;
    const acceptanceCriteriaJson = goal.acceptanceCriteria
      ? JSON.stringify(goal.acceptanceCriteria)
      : null;

    this.db
      .prepare(
        'INSERT INTO goals (id, description, repository, constraints_json, acceptance_criteria_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        goal.id,
        goal.description,
        goal.repository,
        constraintsJson,
        acceptanceCriteriaJson,
        now,
      );

    return {
      id: goal.id,
      description: goal.description,
      repository: goal.repository,
      constraintsJson: constraintsJson ?? undefined,
      acceptanceCriteriaJson: acceptanceCriteriaJson ?? undefined,
      createdAt: now,
    };
  }

  get(id: string): GoalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as
      | {
          id: string;
          description: string;
          repository: string;
          constraints_json: string | null;
          acceptance_criteria_json: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      id: row.id,
      description: row.description,
      repository: row.repository,
      constraintsJson: row.constraints_json ?? undefined,
      acceptanceCriteriaJson: row.acceptance_criteria_json ?? undefined,
      createdAt: row.created_at,
    };
  }
}
