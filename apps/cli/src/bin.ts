#!/usr/bin/env node
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // ignore if .env does not exist
  }
}

// TaskForge stores state with node:sqlite, which Node still flags as
// experimental. Hide only that notice (every other warning is kept) so it does
// not print above the output of every command.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(text)) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

// Imported after the filter is installed (static imports are hoisted above it).
const { createCli } = await import('./cli.js');

const program = createCli();
try {
  await program.parseAsync(process.argv);
} catch (error) {
  // Print failures (bad configuration, missing repository, ...) as a short
  // message instead of a raw stack trace. Set TASKFORGE_DEBUG=1 for the stack.
  const err = error as Error;
  console.error(`\n✖ ${err.message}\n`);
  if (process.env.TASKFORGE_DEBUG) console.error(err.stack);
  process.exitCode = 1;
}
