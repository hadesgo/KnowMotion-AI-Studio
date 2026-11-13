import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'dist/**',
    'examples/**',
    'node_modules/**',
    'renders/**',
    'src-tauri/target/**',
    'src-tauri/resources/**',
    'src-tauri/binaries/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
  },
  {
    files: [
      'eslint.config.js',
      'scripts/**/*.{ts,mjs}',
      'tests/**/*.{ts,tsx}',
      'vite.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
