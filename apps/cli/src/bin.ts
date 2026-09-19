#!/usr/bin/env node
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // ignore if .env does not exist
  }
}

import { createCli } from './cli.js';

const program = createCli();
program.parse(process.argv);
