'use strict';

const js = require('@eslint/js');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'flatpak/build/**',
      'flatpak/repo/**',
      'flatpak/.flatpak-builder/**',
      'flatpak/node-sources.json',
      'assets/**',
      'dist/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        // Node APIs available to the main process and the build scripts.
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
                Response: 'readonly',
                globalThis: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // The preload script is evaluated inside the renderer, so it sees the DOM
    // globals rather than Node's.
    files: ['src/preload.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        MutationObserver: 'readonly',
        navigator: 'readonly',
        Element: 'readonly',
        CSS: 'readonly',
        crypto: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
];
