import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@taskforge/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@taskforge/persistence': path.resolve(__dirname, 'packages/persistence/src/index.ts'),
      '@taskforge/execution': path.resolve(__dirname, 'packages/execution/src/index.ts'),
      '@taskforge/workspace': path.resolve(__dirname, 'packages/workspace/src/index.ts'),
      '@taskforge/agents': path.resolve(__dirname, 'packages/agents/src/index.ts'),
      '@taskforge/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@taskforge/verification': path.resolve(__dirname, 'packages/verification/src/index.ts'),
      '@taskforge/integration': path.resolve(__dirname, 'packages/integration/src/index.ts'),
      '@taskforge/scheduler': path.resolve(__dirname, 'packages/scheduler/src/index.ts'),
      '@taskforge/planner': path.resolve(__dirname, 'packages/planner/src/index.ts'),
      '@taskforge/negotiation': path.resolve(__dirname, 'packages/negotiation/src/index.ts'),
      '@taskforge/router': path.resolve(__dirname, 'packages/router/src/index.ts'),
      '@taskforge/collaboration': path.resolve(__dirname, 'packages/collaboration/src/index.ts'),
      '@taskforge/operator': path.resolve(__dirname, 'packages/operator/src/index.ts'),
      '@taskforge/conversation': path.resolve(__dirname, 'packages/conversation/src/index.ts'),
      '@taskforge/plugins': path.resolve(__dirname, 'packages/plugins/src/index.ts'),
      '@taskforge/telemetry': path.resolve(__dirname, 'packages/telemetry/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    testTimeout: 30000,
  },
});
