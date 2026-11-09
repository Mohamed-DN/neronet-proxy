import { describe, expect, it, vi } from 'vitest';

import { KeyGenerationUnavailable, generateDeviceKeys } from './keys';
import { x25519Base } from './x25519';

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const alicePriv = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
const alicePub = hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');

// Fixed bytes for the fallback paths; the test checks consistency, not randomness.
const seeded = (a: Uint8Array): Uint8Array => {
  for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 0xff;
  return a;
};

describe('generateDeviceKeys', () => {
  it('uses WebCrypto when it supports X25519', async () => {
    const subtle = {
      generateKey: vi.fn(async () => ({ privateKey: {}, publicKey: {} })),
      exportKey: vi.fn(async () => ({ kty: 'OKP', crv: 'X25519', d: b64url(alicePriv), x: b64url(alicePub) }))
    } as unknown as SubtleCrypto;

    const keys = await generateDeviceKeys({ subtle, getRandomValues: seeded });

    expect(keys.method).toBe('webcrypto');
    expect(keys.privateKey).toBe(b64(alicePriv));
    expect(keys.publicKey).toBe(b64(alicePub));
  });

  it('falls back to the pure implementation when generateKey throws', async () => {
    const subtle = {
      generateKey: vi.fn(async () => {
        throw new DOMException('not supported', 'NotSupportedError');
      }),
      exportKey: vi.fn()
    } as unknown as SubtleCrypto;

    const keys = await generateDeviceKeys({ subtle, getRandomValues: seeded });

    expect(keys.method).toBe('fallback');
    expect(keys.publicKey).toBe(b64(x25519Base(fromB64(keys.privateKey))));
  });

  it('falls back to the pure implementation when there is no subtle crypto (insecure origin)', async () => {
    const keys = await generateDeviceKeys({ subtle: undefined, getRandomValues: seeded });

    expect(keys.method).toBe('fallback');
    expect(keys.publicKey).toBe(b64(x25519Base(fromB64(keys.privateKey))));
  });

  it('throws KeyGenerationUnavailable without getRandomValues', async () => {
    await expect(generateDeviceKeys({ subtle: undefined, getRandomValues: undefined })).rejects.toBeInstanceOf(
      KeyGenerationUnavailable
    );
  });

  it('makes three 44-character base64 keys that each decode to 32 bytes', async () => {
    const keys = await generateDeviceKeys();

    for (const value of [keys.privateKey, keys.publicKey, keys.presharedKey]) {
      expect(value).toHaveLength(44);
      expect(value).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(fromB64(value)).toHaveLength(32);
    }
  });
});
