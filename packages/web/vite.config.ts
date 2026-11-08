import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, the proxy plays tailscale serve's part: it adds the login header the server requires.
const login = process.env.KAMAJI_LOGIN ?? 'dev@localhost';

export default defineConfig({
  plugins: [react({ jsxImportSource: '@emotion/react' })],
  resolve: {
    alias: {
      '@kamaji/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:10002',
        headers: { 'Tailscale-User-Login': login },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
