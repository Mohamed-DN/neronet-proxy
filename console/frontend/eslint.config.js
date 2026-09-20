import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

/*
 * Three tiers, by what the file is.
 *
 * The rules of hooks apply everywhere, JavaScript pages included: a hook called
 * conditionally or an effect that captures a stale value is a defect in any
 * language, and the pages are being moved onto query hooks one work package at
 * a time.
 *
 * The accessibility rules are errors over the TypeScript tree only: the
 * primitives under src/ui and the shell, routes and data layer. The pages under
 * src/components carry an accessibility backlog of their own that their work
 * packages clear, and turning the rules on for them today would produce a list
 * nobody can act on.
 *
 * The pages were not linted at all before this: the flat config named only
 * `src/ui/**` and ESLint lints nothing else with a JSX extension. Linting them
 * now surfaces 176 unused imports left behind by earlier edits. Those belong to
 * the work packages that rewrite each page, so no-unused-vars is off there
 * rather than fixed here in passing, and stays an error everywhere else.
 */
export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
      globals: { ...globals.browser }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y, '@typescript-eslint': tseslint.plugin },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // The console labels its own controls; a native title attribute is not a
      // label and the rule is right to say so.
      'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/components/**/*.jsx'],
    rules: { 'no-unused-vars': 'off' }
  },
  {
    files: ['src/**/*.test.{ts,tsx,js,jsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  }
];
