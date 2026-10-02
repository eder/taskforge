#!/usr/bin/env node
// Usage: node scripts/set-version.mjs 0.2.0
// Sets the same version on the root and every workspace package (lockstep releases).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkspacePackages, repoRoot } from './workspace-packages.mjs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <semver>   (e.g. 0.2.0 or 0.2.0-rc.1)');
  process.exit(1);
}

const targets = [{ file: join(repoRoot, 'package.json') }, ...listWorkspacePackages()];
for (const { file } of targets) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}
console.log(`Set version ${version} on ${targets.length} package.json files.`);
console.log('Next: update CHANGELOG.md, commit, then tag with:  git tag v' + version);
