// craftish-care's request tests against the local DDEV WordPress (dev/README.md). Run with
// `npm run test:plugin`; plain `npm run check` doesn't need DDEV and skips them.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugin/tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
