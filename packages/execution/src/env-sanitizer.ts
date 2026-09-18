export interface EnvironmentPolicy {
  inherit?: boolean;
  allow?: string[];
  denyPatterns?: string[];
}

export const DEFAULT_ENV_POLICY: EnvironmentPolicy = {
  inherit: false,
  allow: ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'NODE_ENV', 'LANG', 'TERM'],
  denyPatterns: ['*PASSWORD*', '*SECRET*', '*TOKEN*', '*API_KEY*'],
};

export function matchesPattern(str: string, pattern: string): boolean {
  const regexPattern = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${regexPattern}$`, 'i').test(str);
}

export function sanitizeEnvironment(
  parentEnv: Record<string, string | undefined> = process.env,
  customEnv: Record<string, string> = {},
  policy: EnvironmentPolicy = DEFAULT_ENV_POLICY,
): Record<string, string> {
  const result: Record<string, string> = {};

  const allowedSet = new Set(policy.allow ?? []);
  const denyPatterns = policy.denyPatterns ?? [];

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;

    // Check if key is explicitly allowed or if inherit is true
    const isAllowed = allowedSet.has(key) || policy.inherit === true;
    if (!isAllowed) continue;

    // Check if key matches deny pattern
    const isDenied = denyPatterns.some((pattern) => matchesPattern(key, pattern));
    if (isDenied) continue;

    result[key] = value;
  }

  // Explicitly passed custom env variables are added
  for (const [key, value] of Object.entries(customEnv)) {
    result[key] = value;
  }

  return result;
}
