/*
 * The one part of Node's fs module a test uses: reading a project file as text, for the tests
 * that check the design tokens in styles/tokens.css (vitest turns a CSS import into an empty
 * string). The project has no @types/node.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
