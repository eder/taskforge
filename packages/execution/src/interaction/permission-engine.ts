import { PermissionDecision, InteractionScope, TaskForgeConfig } from '@taskforge/shared';
import { InteractionRepository } from '@taskforge/persistence';

export interface PermissionEvaluationContext {
  category: string;
  operation: string;
  resource?: string;
  taskId?: string;
  runId?: string;
}

export class PermissionEngine {
  private config: TaskForgeConfig['permissions'];
  private interactionRepo?: InteractionRepository;
  private inMemoryApprovals: Map<
    string,
    { decision: PermissionDecision; scope: InteractionScope; taskId?: string; runId?: string }
  > = new Map();

  constructor(config?: TaskForgeConfig['permissions'], interactionRepo?: InteractionRepository) {
    this.config = config ?? {
      filesystem: {
        workspace_write: 'allow',
        outside_workspace: 'ask_human',
        delete_files: 'ask_human',
      },
      commands: {
        tests: 'allow',
        lint: 'allow',
        package_install: 'ask_human',
        network: 'ask_human',
        sudo: 'deny',
      },
      git: {
        commit: 'allow',
        push: 'ask_human',
        force_push: 'deny',
        merge_main: 'deny',
      },
      fallback: 'ask_human',
    };
    this.interactionRepo = interactionRepo;
  }

  public evaluate(context: PermissionEvaluationContext): PermissionDecision {
    const { category, operation, resource, taskId, runId } = context;

    // 1. Check persistent or in-memory active approvals
    if (resource) {
      if (this.interactionRepo) {
        const approval = this.interactionRepo.findActiveApproval(category, resource, taskId, runId);
        if (approval && approval.decision === 'allow') {
          return 'allow';
        }
      }
      const memKey = `${category}:${resource}`;
      const memApproval = this.inMemoryApprovals.get(memKey);
      if (memApproval) {
        if (memApproval.scope === 'project') return memApproval.decision;
        if (memApproval.scope === 'run' && runId && memApproval.runId === runId)
          return memApproval.decision;
        if (memApproval.scope === 'task' && taskId && memApproval.taskId === taskId)
          return memApproval.decision;
      }
    }

    // 2. Deterministic category policy
    if (category === 'filesystem') {
      const op = operation.toLowerCase();
      if (op === 'workspace_write' || op.includes('write_in_workspace') || op === 'write') {
        return this.config.filesystem.workspace_write;
      }
      if (op === 'outside_workspace' || op.includes('outside') || op.includes('write_outside')) {
        return this.config.filesystem.outside_workspace;
      }
      if (
        op === 'delete_files' ||
        op.includes('delete') ||
        op.includes('unlink') ||
        op.includes('remove')
      ) {
        return this.config.filesystem.delete_files;
      }
      return this.config.fallback;
    }

    if (category === 'commands') {
      const cmd = (resource ? `${operation} ${resource}` : operation).toLowerCase();
      if (cmd.includes('sudo') || cmd.includes('doas') || cmd.includes('su -')) {
        return this.config.commands.sudo;
      }
      if (
        cmd.includes('test') ||
        cmd.includes('vitest') ||
        cmd.includes('jest') ||
        cmd.includes('pytest')
      ) {
        return this.config.commands.tests;
      }
      if (
        cmd.includes('lint') ||
        cmd.includes('eslint') ||
        cmd.includes('prettier') ||
        cmd.includes('typecheck')
      ) {
        return this.config.commands.lint;
      }
      if (
        cmd.includes('install') ||
        cmd.includes('add') ||
        cmd.includes('pnpm add') ||
        cmd.includes('npm i') ||
        cmd.includes('pip install')
      ) {
        return this.config.commands.package_install;
      }
      if (
        cmd.includes('curl') ||
        cmd.includes('wget') ||
        cmd.includes('http') ||
        cmd.includes('fetch') ||
        cmd.includes('ping')
      ) {
        return this.config.commands.network;
      }
      return this.config.fallback;
    }

    if (category === 'git') {
      const op = operation.toLowerCase();
      if (op.includes('force') || (resource && resource.includes('--force'))) {
        return this.config.git.force_push;
      }
      if (
        op.includes('merge') &&
        (op.includes('main') || (resource && resource.includes('main')))
      ) {
        return this.config.git.merge_main;
      }
      if (op.includes('commit')) {
        return this.config.git.commit;
      }
      if (op.includes('push')) {
        return this.config.git.push;
      }
      return this.config.fallback;
    }

    return this.config.fallback;
  }

  public recordApproval(
    category: string,
    resource: string,
    decision: PermissionDecision,
    scope: InteractionScope = 'task',
    taskId?: string,
    runId?: string,
  ): void {
    const memKey = `${category}:${resource}`;
    this.inMemoryApprovals.set(memKey, { decision, scope, taskId, runId });
  }

  public clearApprovals(): void {
    this.inMemoryApprovals.clear();
  }
}
