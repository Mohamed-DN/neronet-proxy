import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/*
 * The accessibility rules are errors under src/ui, where the primitives are
 * written once and used everywhere, and are not applied to the pages yet: they
 * carry a backlog of their own that their work packages clear. Turning them on
 * for the whole tree today would produce a list nobody can act on.
 */
export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
      globals: { ...globals.browser }
    },
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
    files: ['src/ui/**/*.test.tsx', 'src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  }
];
