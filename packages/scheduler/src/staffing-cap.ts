import type { RoutingDecision } from '@taskforge/core';

type Role = RoutingDecision['roles'][number];

/**
 * Reduces a team to `max` roles without losing the one that matters. Cutting the list
 * from the front can leave a writable task with no implementer (the router often lists
 * a researcher first). Keep the implementer when the task changes code, then prefer a
 * reviewer (cheap: it reads a diff) over further explorers.
 */
export function capRoles(roles: Role[], max: number, writesCode: boolean): Role[] {
  if (roles.length <= max) return roles;
  const rank = (role: Role): number => {
    const name = String(role.role);
    if (writesCode && name === 'implementer') return 0;
    if (/review/i.test(name)) return 1;
    return 2;
  };
  return roles
    .map((role, index) => ({ role, index }))
    .sort((a, b) => rank(a.role) - rank(b.role) || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index) // keep the router's order among the survivors
    .map((entry) => entry.role);
}
