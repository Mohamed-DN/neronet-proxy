/*
 * The one part of Node's crypto module the tests use: WebCrypto, the same API the
 * browser exposes as globalThis.crypto. jsdom has no crypto.subtle, so the NeroDrop
 * tests hand Node's to the code under test. The project has no @types/node.
 */
declare module 'node:crypto' {
  export const webcrypto: Crypto;
}
