import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The screenshots' end-to-end test with the real image and Docker Desktop (e2e.test.ts), laptop
// only.
export default defineConfig({
  resolve: {
    alias: {
      '@kamaji/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['shots/e2e.test.ts'], fileParallelism: false },
});
