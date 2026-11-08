import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', 'data/', '**/node_modules/', '**/.wrangler/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['worker/src/**/*.js'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
);
