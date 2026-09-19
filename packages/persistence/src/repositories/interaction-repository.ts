import {
  InteractionRequest,
  InteractionResponse,
  InteractionType,
  InteractionStatus,
  InteractionPriority,
  InteractionScope,
  ResolutionSource,
} from '@taskforge/shared';
import { TaskForgeDatabase } from '../database.js';

export class InteractionRepository {
  constructor(private db: TaskForgeDatabase) {}

  public createRequest(request: InteractionRequest): void {
    const stmt = this.db.prepare(`
      INSERT INTO interaction_requests (
        id, run_id, task_id, assignment_id, agent_id, type, prompt,
        category, resource, status, priority, timeout_ms, scope, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      request.id,
      request.runId,
      request.taskId,
      request.assignmentId,
      request.agentId,
      request.type,
      request.prompt,
      request.category ?? null,
      request.resource ?? null,
      request.status,
      request.priority,
      request.timeoutMs ?? null,
      request.scope ?? null,
      request.createdAt,
      request.resolvedAt ?? null,
    );
  }

  public getRequest(id: string): InteractionRequest | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM interaction_requests WHERE id = ?
    `);
    const row = stmt.get(id);
    if (!row) return undefined;
    return this.mapRequest(row);
  }

  public getPendingRequests(runId?: string): InteractionRequest[] {
    let query = `SELECT * FROM interaction_requests WHERE status = 'pending'`;
    const params: unknown[] = [];
    if (runId) {
      query += ` AND run_id = ?`;
      params.push(runId);
    }
    query += ` ORDER BY created_at ASC`;
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);
    return rows.map((r) => this.mapRequest(r));
  }

  public updateRequestStatus(id: string, status: InteractionStatus, resolvedAt?: string): void {
    const stmt = this.db.prepare(`
      UPDATE interaction_requests
      SET status = ?, resolved_at = ?
      WHERE id = ?
    `);
    stmt.run(status, resolvedAt ?? new Date().toISOString(), id);
  }

  public createResponse(response: InteractionResponse): void {
    const stmt = this.db.prepare(`
      INSERT INTO interaction_responses (
        id, request_id, decision, payload, source, scope, responder_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      response.id,
      response.requestId,
      response.decision,
      response.payload ?? null,
      response.source,
      response.scope,
      response.responderId ?? null,
      response.createdAt,
    );
  }

  public getResponsesForRequest(requestId: string): InteractionResponse[] {
    const stmt = this.db.prepare(`
      SELECT * FROM interaction_responses WHERE request_id = ? ORDER BY created_at ASC
    `);
    const rows = stmt.all(requestId);
    return rows.map((r) => this.mapResponse(r));
  }

  public listAllRequests(runId?: string): InteractionRequest[] {
    let query = `SELECT * FROM interaction_requests`;
    const params: unknown[] = [];
    if (runId) {
      query += ` WHERE run_id = ?`;
      params.push(runId);
    }
    query += ` ORDER BY created_at ASC`;
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);
    return rows.map((r) => this.mapRequest(r));
  }

  public findActiveApproval(category: string, resource: string, taskId?: string, runId?: string): InteractionResponse | undefined {
    // Check if there is an approved interaction response with scope 'project', or 'run' for the same run, or 'task' for the same task
    const stmt = this.db.prepare(`
      SELECT r.*, req.category, req.resource, req.task_id, req.run_id
      FROM interaction_responses r
      JOIN interaction_requests req ON r.request_id = req.id
      WHERE r.decision = 'allow'
        AND req.category = ?
        AND req.resource = ?
      ORDER BY r.created_at DESC
    `);
    const rows = stmt.all(category, resource);
    for (const row of rows) {
      const scope = row.scope as InteractionScope;
      if (scope === 'project') return this.mapResponse(row);
      if (scope === 'run' && runId && row.run_id === runId) return this.mapResponse(row);
      if (scope === 'task' && taskId && row.task_id === taskId) return this.mapResponse(row);
    }
    return undefined;
  }

  private mapRequest(row: Record<string, unknown>): InteractionRequest {
    return {
      id: row.id as string,
      runId: row.run_id as string,
      taskId: row.task_id as string,
      assignmentId: row.assignment_id as string,
      agentId: row.agent_id as string,
      type: row.type as InteractionType,
      prompt: row.prompt as string,
      category: (row.category as string) || undefined,
      resource: (row.resource as string) || undefined,
      status: row.status as InteractionStatus,
      priority: row.priority as InteractionPriority,
      timeoutMs: row.timeout_ms ? (row.timeout_ms as number) : undefined,
      scope: (row.scope as InteractionScope) || undefined,
      createdAt: row.created_at as string,
      resolvedAt: (row.resolved_at as string) || undefined,
    };
  }

  private mapResponse(row: Record<string, unknown>): InteractionResponse {
    return {
      id: row.id as string,
      requestId: row.request_id as string,
      decision: row.decision as 'allow' | 'deny' | 'answer' | 'cancel',
      payload: (row.payload as string) || undefined,
      source: row.source as ResolutionSource,
      scope: row.scope as InteractionScope,
      responderId: (row.responder_id as string) || undefined,
      createdAt: row.created_at as string,
    };
  }
}
