/**
 * X25519 (RFC 7748) over BigInt, used only when WebCrypto cannot make the key.
 *
 * This is the Montgomery ladder from RFC 7748 section 5, written out so the
 * console can still make a device key on a browser without X25519 in
 * `crypto.subtle`, or on an insecure origin where `subtle` is absent. It is
 * not constant-time: BigInt arithmetic is not. That is acceptable here because
 * the key is made once, in the browser, for one device, and never leaves it.
 * Where WebCrypto works, it is preferred.
 */

const P = (1n << 255n) - 19n;
const A24 = 121665n;
const BASE_U = (() => {
  const u = new Uint8Array(32);
  u[0] = 9;
  return u;
})();

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i] as number);
  return n;
}

function bigIntToBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function powMod(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/** RFC 7748 section 5: X25519(k, u). Clamps the scalar and masks the top bit of u. */
export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  if (scalar.length !== 32 || u.length !== 32) {
    throw new RangeError('X25519 takes a 32-byte scalar and a 32-byte coordinate');
  }

  const k = new Uint8Array(scalar);
  k[0] = (k[0] as number) & 248;
  k[31] = ((k[31] as number) & 127) | 64;
  const kn = bytesToBigInt(k);

  const uc = new Uint8Array(u);
  uc[31] = (uc[31] as number) & 127;
  const x1 = mod(bytesToBigInt(uc));

  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const kt = (kn >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;

    const A = mod(x2 + z2);
    const AA = mod(A * A);
    const B = mod(x2 - z2);
    const BB = mod(B * B);
    const E = mod(AA - BB);
    const C = mod(x3 + z3);
    const D = mod(x3 - z3);
    const DA = mod(D * A);
    const CB = mod(C * B);
    x3 = mod((DA + CB) * (DA + CB));
    z3 = mod(x1 * mod((DA - CB) * (DA - CB)));
    x2 = mod(AA * BB);
    z2 = mod(E * mod(AA + A24 * E));
  }

  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  return bigIntToBytes(mod(x2 * powMod(z2, P - 2n)));
}

/** The public key for a private key: X25519(k, 9). */
export function x25519Base(scalar: Uint8Array): Uint8Array {
  return x25519(scalar, BASE_U);
}
