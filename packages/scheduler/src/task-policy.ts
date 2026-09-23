import { TaskForgeConfig } from '@taskforge/shared';
import { Task } from '@taskforge/core';

function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function ruleMatchesScope(ruleScope: string, taskScope: string): boolean {
  const rule = normalizeScope(ruleScope);
  const scope = normalizeScope(taskScope);

  if (rule === '*') return true;
  // A task with repository-wide writable scope cannot safely inherit a
  // narrower ownership rule. The planner must narrow the task first.
  if (scope === '*') return false;

  if (rule === scope) return true;
  if (rule.endsWith('/**')) {
    const prefix = rule.slice(0, -3);
    return scope === prefix || scope.startsWith(`${prefix}/`);
  }
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3);
    return rule === prefix || rule.startsWith(`${prefix}/`);
  }
  return false;
}

function specificity(scope: string): number {
  return normalizeScope(scope).replace(/[*?]/g, '').length;
}

export function allowedWritersForTask(
  task: Task,
  config: TaskForgeConfig,
): Set<string> | undefined {
  const scopes = task.contract.allowedScope ?? [];
  if (scopes.length === 0) return undefined;

  let allowed: Set<string> | undefined;

  for (const taskScope of scopes) {
    const matches = config.ownership.rules
      .filter((rule) => ruleMatchesScope(rule.scope, taskScope))
      .sort((a, b) => specificity(b.scope) - specificity(a.scope));

    if (matches.length === 0) continue;

    const mostSpecific = specificity(matches[0].scope);
    const writers = new Set(
      matches
        .filter((rule) => specificity(rule.scope) === mostSpecific)
        .flatMap((rule) => rule.writers),
    );

    allowed =
      allowed === undefined
        ? writers
        : new Set([...allowed].filter((agentId) => writers.has(agentId)));
  }

  return allowed;
}

export function verificationCommandsForTask(
  task: Task,
  config: TaskForgeConfig,
): string[] | undefined {
  const commands = new Set(config.verification.commands);
  const scopes = task.contract.allowedScope ?? [];

  for (const taskScope of scopes) {
    const matches = config.verification.scopedCommands
      .filter((rule) => ruleMatchesScope(rule.scope, taskScope))
      .sort((a, b) => specificity(b.scope) - specificity(a.scope));

    if (matches.length === 0) continue;
    const mostSpecific = specificity(matches[0].scope);
    for (const rule of matches.filter((item) => specificity(item.scope) === mostSpecific)) {
      for (const command of rule.commands) commands.add(command);
    }
  }

  return commands.size > 0 ? [...commands] : undefined;
}
