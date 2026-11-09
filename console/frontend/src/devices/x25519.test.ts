import { describe, expect, it } from 'vitest';

import { x25519, x25519Base } from './x25519';

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('x25519 (RFC 7748)', () => {
  // RFC 7748 section 5.2, test vector 1.
  it('matches section 5.2 vector 1', () => {
    const out = x25519(
      hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
      hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
    );
    expect(toHex(out)).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
  });

  // RFC 7748 section 5.2, test vector 2.
  it('matches section 5.2 vector 2', () => {
    const out = x25519(
      hex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'),
      hex('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493')
    );
    expect(toHex(out)).toBe('95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957');
  });

  // RFC 7748 section 6.1, Alice and Bob.
  const alicePriv = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const alicePub = hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  const bobPriv = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  const bobPub = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');

  it('derives Alice and Bob public keys from the base point (section 6.1)', () => {
    expect(toHex(x25519Base(alicePriv))).toBe(toHex(alicePub));
    expect(toHex(x25519Base(bobPriv))).toBe(toHex(bobPub));
  });

  it('agrees on the shared secret from both sides (section 6.1)', () => {
    const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(toHex(x25519(alicePriv, bobPub))).toBe(shared);
    expect(toHex(x25519(bobPriv, alicePub))).toBe(shared);
  });

  it('rejects inputs that are not 32 bytes', () => {
    expect(() => x25519(new Uint8Array(31), alicePub)).toThrow(RangeError);
    expect(() => x25519(alicePriv, new Uint8Array(33))).toThrow(RangeError);
  });
});
