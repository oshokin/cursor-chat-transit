const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '.dev/**',
      '.vscode-test/**',
      'coverage/**',
      'tmp/**',
      'resources/sidebar-client.js',
    ],
  },
  {
    files: ['**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: globals.node,
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['webview/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.name=/^(execSync|execFileSync|spawnSync)$/]',
          message: 'Use the asynchronous SQLite transport.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(execSync|execFileSync|spawnSync)$/]',
          message: 'Use the asynchronous SQLite transport.',
        },
      ],
    },
  },
);
