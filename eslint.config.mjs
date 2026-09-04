import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', 'runs/**', 'coverage/**'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'constructor-super': 'error',
      eqeqeq: ['error', 'always'],
      'no-constant-binary-expression': 'error',
      'no-duplicate-imports': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-useless-assignment': 'error',
      'no-useless-catch': 'error',
      'prefer-const': 'error',
    },
  },
]
