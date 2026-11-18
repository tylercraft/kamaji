import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The rollback's end-to-end test against the DDEV WordPress (ddev.test.ts), laptop only.
export default defineConfig({
  resolve: {
    alias: {
      '@kamaji/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['site-push/ddev.test.ts'], fileParallelism: false },
});
