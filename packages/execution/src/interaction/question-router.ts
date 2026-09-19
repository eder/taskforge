import { QuestionRoutingOutcome, TaskContract } from '@taskforge/shared';
import { PermissionEngine } from './permission-engine.js';

export interface QuestionContext {
  prompt: string;
  options?: string[];
  taskId?: string;
  runId?: string;
  taskContract?: TaskContract;
  contextData?: Record<string, unknown>;
  availablePeers?: Array<{ id: string; role: string }>;
}

export interface QuestionRoutingResult {
  outcome: QuestionRoutingOutcome;
  answer?: string;
  targetAgentId?: string;
  reason: string;
}

export class QuestionRouter {
  constructor(private permissionEngine?: PermissionEngine) {}

  public route(ctx: QuestionContext): QuestionRoutingResult {
    const text = ctx.prompt.toLowerCase();

    // 1. Permission checks embedded in questions (e.g. "Can I run sudo...?", "Can I push to main?")
    if (text.includes('sudo') || text.includes('root')) {
      return {
        outcome: 'POLICY_DENY',
        reason: 'Sudo operations are strictly denied by permission policy',
      };
    }
    if (text.includes('force push') || text.includes('push -f')) {
      return {
        outcome: 'POLICY_DENY',
        reason: 'Force push is strictly denied by permission policy',
      };
    }
    if (text.includes('merge main') || text.includes('merge into main')) {
      return {
        outcome: 'POLICY_DENY',
        reason: 'Direct merge to main is strictly denied by permission policy',
      };
    }
    if (
      text.includes('run tests') ||
      text.includes('execute tests') ||
      text.includes('run linter')
    ) {
      return {
        outcome: 'POLICY_ALLOW',
        answer: 'Running verification tests/lint is permitted by policy.',
        reason: 'Test/lint execution allowed by policy',
      };
    }

    // 2. Authoritative Context (AUTO_RESOLVE)
    if (ctx.taskContract) {
      if (
        text.includes('allowed scope') ||
        text.includes('what files can i edit') ||
        text.includes('scope')
      ) {
        return {
          outcome: 'AUTO_RESOLVE',
          answer: `Allowed scope: ${ctx.taskContract.allowedScope.join(', ')}. Forbidden: ${ctx.taskContract.forbiddenChanges.join(', ')}`,
          reason: 'Contract contains authoritative scope boundaries',
        };
      }
      if (
        text.includes('acceptance') ||
        text.includes('criteria') ||
        text.includes('how to verify')
      ) {
        return {
          outcome: 'AUTO_RESOLVE',
          answer: `Acceptance criteria: ${ctx.taskContract.acceptanceCriteria.join('; ')}`,
          reason: 'Contract contains authoritative acceptance criteria',
        };
      }
      if (text.includes('objective') || text.includes('goal of this task')) {
        return {
          outcome: 'AUTO_RESOLVE',
          answer: `Objective: ${ctx.taskContract.objective}`,
          reason: 'Contract contains task objective',
        };
      }
    }

    if (ctx.contextData) {
      for (const [key, value] of Object.entries(ctx.contextData)) {
        if (text.includes(key.toLowerCase())) {
          return {
            outcome: 'AUTO_RESOLVE',
            answer: typeof value === 'string' ? value : JSON.stringify(value),
            reason: `Context entry for "${key}" answers the inquiry`,
          };
        }
      }
    }

    // 3. Technical peer routing (ROUTE_TO_AGENT)
    if (ctx.availablePeers && ctx.availablePeers.length > 0) {
      // If asking an architectural, review, or testing question, route to appropriate peer
      if (
        text.includes('architecture') ||
        text.includes('design pattern') ||
        text.includes('structure')
      ) {
        const archPeer = ctx.availablePeers.find(
          (p) => p.role.includes('architecture') || p.role.includes('lead'),
        );
        if (archPeer) {
          return {
            outcome: 'ROUTE_TO_AGENT',
            targetAgentId: archPeer.id,
            reason: `Routing architectural question to ${archPeer.role} (${archPeer.id})`,
          };
        }
      }
      if (
        text.includes('review') ||
        text.includes('lint error') ||
        text.includes('type error') ||
        text.includes('code style')
      ) {
        const reviewPeer = ctx.availablePeers.find(
          (p) => p.role.includes('reviewer') || p.role.includes('critic'),
        );
        if (reviewPeer) {
          return {
            outcome: 'ROUTE_TO_AGENT',
            targetAgentId: reviewPeer.id,
            reason: `Routing code review question to ${reviewPeer.role} (${reviewPeer.id})`,
          };
        }
      }
      if (
        text.includes('reproduce') ||
        text.includes('failing test') ||
        text.includes('test case')
      ) {
        const testPeer = ctx.availablePeers.find(
          (p) => p.role.includes('reproduction') || p.role.includes('tester'),
        );
        if (testPeer) {
          return {
            outcome: 'ROUTE_TO_AGENT',
            targetAgentId: testPeer.id,
            reason: `Routing test reproduction inquiry to ${testPeer.role} (${testPeer.id})`,
          };
        }
      }
    }

    // 4. Blockers that cannot safely continue
    if (
      text.includes('corrupted') ||
      text.includes('data loss') ||
      text.includes('unrecoverable')
    ) {
      return {
        outcome: 'BLOCK',
        reason: 'Unrecoverable repository or environment state detected',
      };
    }

    // 5. Product or requirement decision needs the user (ASK_HUMAN)
    return {
      outcome: 'ASK_HUMAN',
      reason:
        'Question represents a product, requirement, or external decision requiring human guidance',
    };
  }
}
