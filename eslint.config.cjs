const jsdoc = require('eslint-plugin-jsdoc').default;
const js = require('@eslint/js');
const stylistic = require('@stylistic/eslint-plugin');
const globals = require('globals');
const tseslint = require('typescript-eslint');

/**
 * Blank lines between logical groups. This is the ESLint Stylistic form of
 * newline-before-return, newline-after-var, and padding around multiline
 * blocks. One-line guards stay together. Prettier does not insert these gaps.
 * Later entries win when a pair matches more than one.
 */
const paddingLineBetweenStatements = [
  'error',
  { blankLine: 'always', prev: 'directive', next: '*' },
  { blankLine: 'any', prev: 'directive', next: 'directive' },
  { blankLine: 'always', prev: ['import', 'cjs-import'], next: '*' },
  {
    blankLine: 'any',
    prev: ['import', 'cjs-import'],
    next: ['import', 'cjs-import'],
  },
  { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
  {
    blankLine: 'any',
    prev: ['const', 'let', 'var'],
    next: ['const', 'let', 'var'],
  },
  {
    blankLine: 'always',
    prev: '*',
    next: ['multiline-const', 'multiline-let', 'multiline-var'],
  },
  {
    blankLine: 'always',
    prev: ['multiline-const', 'multiline-let', 'multiline-var'],
    next: '*',
  },
  { blankLine: 'always', prev: '*', next: 'multiline-block-like' },
  { blankLine: 'always', prev: 'multiline-block-like', next: '*' },
  { blankLine: 'always', prev: '*', next: 'multiline-expression' },
  { blankLine: 'always', prev: 'multiline-expression', next: '*' },
  { blankLine: 'always', prev: '*', next: ['return', 'throw'] },
  {
    blankLine: 'always',
    prev: '*',
    next: ['interface', 'type', 'enum'],
  },
  {
    blankLine: 'always',
    prev: ['interface', 'type', 'enum'],
    next: '*',
  },
  { blankLine: 'never', prev: 'function-overload', next: 'function' },
];

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'vendor/**',
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
    plugins: { '@stylistic': stylistic },
    rules: {
      ...js.configs.recommended.rules,
      '@stylistic/padding-line-between-statements':
        paddingLineBetweenStatements,
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
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/padding-line-between-statements':
        paddingLineBetweenStatements,
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
    files: ['src/**/*.ts', 'webview/**/*.ts'],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          enableFixer: false,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
        },
      ],
      'jsdoc/no-types': 'error',
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
