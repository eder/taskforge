import { randomUUID } from 'node:crypto';
import { AgentAssignment, AgentRole } from '@taskforge/shared';

export interface InternalAssignmentNode {
  assignment: AgentAssignment;
  dependencies: string[]; // assignment IDs that must complete first
  isSynthesis?: boolean;
}

export class AssignmentGraph {
  private nodes: Map<string, InternalAssignmentNode> = new Map();

  addNode(assignment: AgentAssignment, dependencies: string[] = [], isSynthesis = false): void {
    this.nodes.set(assignment.id, {
      assignment,
      dependencies,
      isSynthesis,
    });
  }

  getNode(id: string): InternalAssignmentNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): InternalAssignmentNode[] {
    return Array.from(this.nodes.values());
  }

  getRunnableAssignments(completedAssignmentIds: Set<string>): AgentAssignment[] {
    const runnable: AgentAssignment[] = [];
    for (const node of this.nodes.values()) {
      if (completedAssignmentIds.has(node.assignment.id)) continue;
      const allDepsDone = node.dependencies.every((depId) => completedAssignmentIds.has(depId));
      if (allDepsDone) {
        runnable.push(node.assignment);
      }
    }
    return runnable;
  }

  public static buildParallelInvestigationGraph(
    taskId: string,
    investigators: Array<{ id: string; role: AgentRole; objective: string }>,
    implementer: { id: string; role: AgentRole; objective: string },
    reviewer?: { id: string; role: AgentRole; objective: string },
    maxAgents?: number,
  ): AssignmentGraph {
    const graph = new AssignmentGraph();
    const investigatorIds: string[] = [];

    const effectiveInvestigators =
      maxAgents && maxAgents > 0
        ? investigators.slice(0, Math.max(1, maxAgents - (reviewer ? 2 : 1)))
        : investigators;

    // 1. Investigators run in parallel
    for (const inv of effectiveInvestigators) {
      const asgn: AgentAssignment = {
        id: `asgn-${taskId}-${inv.id}-${randomUUID().slice(0, 8)}`,
        taskId,
        agentId: inv.id,
        role: inv.role,
        objective: inv.objective,
        status: 'running',
      };
      graph.addNode(asgn, []);
      investigatorIds.push(asgn.id);
    }

    // 2. Synthesis node depends on all investigators
    const synthesisAsgn: AgentAssignment = {
      id: `asgn-${taskId}-synthesis-${randomUUID().slice(0, 8)}`,
      taskId,
      agentId: implementer.id,
      role: 'lead',
      objective: 'Synthesize findings and evidence into execution specification',
      status: 'pending',
    };
    graph.addNode(synthesisAsgn, investigatorIds, true);

    // 3. Implementer depends on synthesis
    const implAsgn: AgentAssignment = {
      id: `asgn-${taskId}-implementer-${randomUUID().slice(0, 8)}`,
      taskId,
      agentId: implementer.id,
      role: implementer.role,
      objective: implementer.objective,
      status: 'pending',
    };
    graph.addNode(implAsgn, [synthesisAsgn.id]);

    // 4. Reviewer depends on implementer
    if (reviewer) {
      const revAsgn: AgentAssignment = {
        id: `asgn-${taskId}-reviewer-${randomUUID().slice(0, 8)}`,
        taskId,
        agentId: reviewer.id,
        role: reviewer.role,
        objective: reviewer.objective,
        status: 'pending',
      };
      graph.addNode(revAsgn, [implAsgn.id]);
    }

    return graph;
  }
}

export interface SynthesisInput {
  taskId: string;
  investigationOutputs: Array<{ role: string; agentId: string; output: string }>;
}

export interface SynthesisResult {
  rootCause: string;
  recommendedFix: string;
  requiredTest: string;
}

export class SynthesisCoordinator {
  public static synthesize(input: SynthesisInput): SynthesisResult {
    const combined = input.investigationOutputs
      .map((o) => `[${o.role} by ${o.agentId}]: ${o.output}`)
      .join('\n');

    return {
      rootCause: `Synthesized root cause from ${input.investigationOutputs.length} workers:\n${combined}`,
      recommendedFix:
        'Apply idempotent locking and state guardrails based on multi-worker investigation',
      requiredTest: 'Regression test covering concurrent operations without duplicate side effects',
    };
  }
}
