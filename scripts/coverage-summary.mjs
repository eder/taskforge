#!/usr/bin/env node
// Prints a Markdown coverage summary (used for the GitHub Actions job summary).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './workspace-packages.mjs';

const file = join(repoRoot, 'coverage', 'coverage-summary.json');
if (!existsSync(file)) {
  console.log('No coverage summary found.');
  process.exit(0);
}
const { total } = JSON.parse(readFileSync(file, 'utf8'));
console.log('## Coverage\n');
for (const key of ['statements', 'branches', 'functions', 'lines']) {
  const { pct, covered, total: count } = total[key];
  console.log(`- **${key}**: ${pct}% (${covered}/${count})`);
}
