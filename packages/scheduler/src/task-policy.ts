import { TaskForgeConfig } from '@taskforge/shared';
import { Task } from '@taskforge/core';

function normalizeScope(scope: string): string {
  const normalized = scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  // `**` and `*` both mean the whole repository everywhere else (plan-parallelism treats them alike).
  return normalized === '**' ? '*' : normalized;
}

export function ruleMatchesScope(ruleScope: string, taskScope: string): boolean {
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
    const matches = (config.ownership?.rules ?? [])
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
  const commands = new Set(config.verification.commands ?? []);
  const scopes = task.contract.allowedScope ?? [];

  for (const taskScope of scopes) {
    const matches = (config.verification.scopedCommands ?? [])
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

/**
 * The commands a verification task runs. What the project's own configuration
 * says verifies it (`verification.commands`, `scopedCommands`, saved by the
 * person or by `tf init`) wins over what the planner model wrote into the task:
 * the model cannot know that the project needs a virtual environment, and a
 * guess such as `python -m pytest` fails where the configured command works.
 */
export function commandsForVerificationTask(task: Task, config: TaskForgeConfig): string[] {
  return verificationCommandsForTask(task, config) ?? task.contract.verification?.commands ?? [];
}

function isWildcardScope(scope: string): boolean {
  const normalized = normalizeScope(scope);
  return normalized === '' || normalized === '*' || normalized === '**' || normalized === '.';
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // "**/" also matches zero directories
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Whether a repository-relative file path falls inside any of the allowed scopes. */
export function scopeAllowsPath(scopes: string[], filePath: string): boolean {
  const file = normalizeScope(filePath);
  return scopes.some((raw) => {
    if (isWildcardScope(raw)) return true;
    const scope = normalizeScope(raw);
    if (scope.endsWith('/**')) {
      const prefix = scope.slice(0, -3);
      return file === prefix || file.startsWith(`${prefix}/`);
    }
    if (/[*?]/.test(scope)) return globToRegExp(scope).test(file);
    return file === scope || file.startsWith(`${scope}/`);
  });
}

/**
 * Files changed by a task that fall outside its declared writable scope.
 * An empty or repository-wide scope constrains nothing.
 */
export function filesOutsideScope(scopes: string[] | undefined, changedFiles: string[]): string[] {
  if (!scopes || scopes.length === 0 || scopes.some(isWildcardScope)) return [];
  return changedFiles.filter((file) => !scopeAllowsPath(scopes, file));
}
