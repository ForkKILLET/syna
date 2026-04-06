import js from '@eslint/js'
import globals from 'globals'
import ts from 'typescript-eslint'

/** @type {import('eslint').Linter.Config} */
export default [
  { languageOptions: { globals: globals.browser } },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
    ignores: ['dist/'],
  },
];
