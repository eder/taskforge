#!/usr/bin/env node
// Usage: node scripts/verify-release.mjs [tag]
// Fails when the workspace is not in a publishable, lockstep-versioned state.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkspacePackages, repoRoot } from './workspace-packages.mjs';

const problems = [];
const rootVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const packages = listWorkspacePackages();
const names = new Set(packages.map((p) => p.json.name));

for (const { dir, json } of packages) {
  const where = `${json.name} (${dir})`;
  if (json.private) problems.push(`${where}: must not be private`);
  if (json.version !== rootVersion) {
    problems.push(`${where}: version ${json.version} != root ${rootVersion}`);
  }
  if (json.license !== 'MIT') problems.push(`${where}: license must be MIT`);
  if (json.publishConfig?.access !== 'public') problems.push(`${where}: publishConfig.access must be public`);
  if (!json.files?.includes('dist')) problems.push(`${where}: "files" must include dist`);
  if (!json.repository?.url) problems.push(`${where}: missing repository.url`);
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(json[section] ?? {})) {
      if (dep.startsWith('@taskforge/') && !names.has(dep)) problems.push(`${where}: unknown workspace dep ${dep}`);
      if (dep.startsWith('@taskforge/') && range !== 'workspace:*') {
        problems.push(`${where}: ${dep} must use "workspace:*" (found "${range}")`);
      }
    }
  }
}

const tag = process.argv[2];
if (tag) {
  const expected = `v${rootVersion}`;
  if (tag !== expected) problems.push(`tag ${tag} does not match package version (expected ${expected})`);
}

if (problems.length > 0) {
  console.error('Release verification failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`Release verification passed: ${packages.length} packages at ${rootVersion}.`);
