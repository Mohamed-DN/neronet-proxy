import { x25519Base } from './x25519';

/**
 * Keys for a phone or computer, made in the browser.
 *
 * The private key stays in the object returned here. Callers send only the
 * public key and the pre-shared key to the server; nothing in this module
 * writes to storage, the URL or the network.
 */

export interface DeviceKeys {
  /** Standard base64 of 32 bytes. Never leaves the browser. */
  privateKey: string;
  /** Standard base64 of 32 bytes. */
  publicKey: string;
  /** Standard base64 of 32 random bytes. */
  presharedKey: string;
  /** Which path made the X25519 pair. */
  method: 'webcrypto' | 'fallback';
}

export class KeyGenerationUnavailable extends Error {
  constructor() {
    super('This browser cannot create device keys: no secure random source is available.');
    this.name = 'KeyGenerationUnavailable';
  }
}

export interface KeyEnvironment {
  subtle?: SubtleCrypto | undefined;
  getRandomValues?: ((a: Uint8Array) => Uint8Array) | undefined;
}

function defaultEnvironment(): KeyEnvironment {
  const c = globalThis.crypto;
  return {
    subtle: c?.subtle,
    getRandomValues: c ? (a: Uint8Array) => c.getRandomValues(a) : undefined
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function clamp(scalar: Uint8Array): Uint8Array {
  const k = new Uint8Array(scalar);
  k[0] = (k[0] as number) & 248;
  k[31] = ((k[31] as number) & 127) | 64;
  return k;
}

/** Asks WebCrypto for an X25519 pair. Returns null whenever it cannot, so the caller falls back. */
async function webCryptoPair(subtle: SubtleCrypto | undefined): Promise<{ priv: Uint8Array; pub: Uint8Array } | null> {
  if (!subtle) return null;
  try {
    const pair = (await subtle.generateKey({ name: 'X25519' } as unknown as EcKeyGenParams, true, [
      'deriveBits'
    ])) as CryptoKeyPair;
    const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') return null;
    const priv = fromBase64Url(jwk.d);
    const pub = fromBase64Url(jwk.x);
    if (priv.length !== 32 || pub.length !== 32) return null;
    return { priv, pub };
  } catch {
    return null;
  }
}

/**
 * Makes the three keys a device needs. Throws KeyGenerationUnavailable when
 * there is no random source at all; otherwise always returns keys.
 */
export async function generateDeviceKeys(env: KeyEnvironment = defaultEnvironment()): Promise<DeviceKeys> {
  const random = env.getRandomValues;
  if (!random) throw new KeyGenerationUnavailable();

  const presharedKey = random(new Uint8Array(32));
  const web = await webCryptoPair(env.subtle);

  if (web) {
    return {
      privateKey: toBase64(web.priv),
      publicKey: toBase64(web.pub),
      presharedKey: toBase64(presharedKey),
      method: 'webcrypto'
    };
  }

  const priv = clamp(random(new Uint8Array(32)));
  return {
    privateKey: toBase64(priv),
    publicKey: toBase64(x25519Base(priv)),
    presharedKey: toBase64(presharedKey),
    method: 'fallback'
  };
}
