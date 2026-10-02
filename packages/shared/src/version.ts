import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Single source of truth for the TaskForge version shown by the CLI and the
 * REPL banner. All workspace packages are versioned in lockstep (enforced by
 * tests/release-metadata.test.ts), so this package's version is the product's.
 */
export const TASKFORGE_VERSION: string = (require('../package.json') as { version: string })
  .version;
