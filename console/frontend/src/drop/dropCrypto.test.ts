import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CHUNK_BYTES,
  DropIntegrityError,
  Decryptor,
  ciphertextLength,
  encryptFile,
  newFileKey,
  type Manifest,
  type Source
} from './dropCrypto';

// Node's WebCrypto is the same API the browser has (crypto.subtle); jsdom has none.
const subtle = webcrypto.subtle;
const ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function source(data: Uint8Array): Source {
  return { size: data.length, read: async (start, end) => data.slice(start, end) };
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function seal(data: Uint8Array, key: Uint8Array, manifest: Partial<Manifest> = {}, id = ID) {
  const parts = await encryptFile(source(data), { name: 'report.pdf', type: 'application/pdf', ...manifest }, id, key, {
    subtle
  });
  return join(parts);
}

/** Feeds the ciphertext in pieces of `step` bytes, as a network stream would. */
async function open(cipher: Uint8Array, key: Uint8Array, id = ID, step = 65_536) {
  const d = new Decryptor(id, key, { subtle });
  for (let at = 0; at < cipher.length; at += step) await d.push(cipher.slice(at, at + step));
  return d.finish();
}

// toEqual walks a megabyte through its diff machinery; a plain loop is enough here.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const key = () => newFileKey(webcrypto);

describe('NeroDrop encryption (AES-256-GCM in 1 MiB chunks)', () => {
  it.each([0, 1, 1000, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES + 12_345])(
    'round-trips %i bytes, and the ciphertext has the announced length',
    { timeout: 30_000 },
    async (size) => {
      const k = key();
      const data = bytes(size, size + 7);
      const cipher = await seal(data, k);
      expect(cipher.length).toBe(ciphertextLength(size));
      const { manifest, parts } = await open(cipher, k);
      expect(sameBytes(join(parts), data)).toBe(true);
      expect(manifest).toEqual({ v: 1, name: 'report.pdf', type: 'application/pdf', size, chunk: CHUNK_BYTES });
    }
  );

  it('makes a fresh 256-bit key every time', () => {
    const a = key();
    const b = key();
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
  });

  it('never puts the file name or the content in the ciphertext', async () => {
    const marker = new TextEncoder().encode('NERODROP-PLAINTEXT-MARKER-'.repeat(2000));
    const cipher = await seal(marker, key(), { name: 'secret-plan-marker.pdf' });
    const asText = new TextDecoder('latin1').decode(cipher);
    expect(asText).not.toContain('NERODROP-PLAINTEXT-MARKER');
    expect(asText).not.toContain('secret-plan-marker');
  });

  it('gives the same file sent twice two different ciphertexts', async () => {
    const data = bytes(5000);
    const a = await seal(data, key());
    const b = await seal(data, key());
    expect(a).not.toEqual(b);
  });

  it('refuses the wrong key', async () => {
    const cipher = await seal(bytes(10), key());
    await expect(open(cipher, key())).rejects.toBeInstanceOf(DropIntegrityError);
  });

  it('refuses the ciphertext of another transfer id', async () => {
    const k = key();
    const cipher = await seal(bytes(10), k, {}, OTHER_ID);
    await expect(open(cipher, k)).rejects.toBeInstanceOf(DropIntegrityError);
  });

  it('refuses one flipped byte anywhere', async () => {
    const k = key();
    const cipher = await seal(bytes(CHUNK_BYTES + 100), k);
    for (const at of [0, 1100, CHUNK_BYTES, cipher.length - 1]) {
      const bad = cipher.slice();
      bad[at] = (bad[at] as number) ^ 1;
      await expect(open(bad, k), `byte ${at}`).rejects.toBeInstanceOf(DropIntegrityError);
    }
  });

  it('refuses truncation, at a chunk boundary or inside a chunk', async () => {
    const k = key();
    const data = bytes(2 * CHUNK_BYTES + 10);
    const cipher = await seal(data, k);
    const firstTwo = 1040 + 2 * (CHUNK_BYTES + 16);
    for (const end of [firstTwo, cipher.length - 1, 1040]) {
      await expect(open(cipher.slice(0, end), k), `cut at ${end}`).rejects.toBeInstanceOf(DropIntegrityError);
    }
  });

  it('refuses extra bytes after the last chunk', async () => {
    const k = key();
    const cipher = await seal(bytes(100), k);
    await expect(open(join([cipher, new Uint8Array([0])]), k)).rejects.toBeInstanceOf(DropIntegrityError);
  });

  it('refuses two chunks swapped', async () => {
    const k = key();
    const cipher = await seal(bytes(3 * CHUNK_BYTES), k);
    const size = CHUNK_BYTES + 16;
    const a = cipher.slice(1040, 1040 + size);
    const b = cipher.slice(1040 + size, 1040 + 2 * size);
    const swapped = cipher.slice();
    swapped.set(b, 1040);
    swapped.set(a, 1040 + size);
    await expect(open(swapped, k)).rejects.toBeInstanceOf(DropIntegrityError);
  });

  it('keeps a very long file name inside the fixed-size manifest', async () => {
    const k = key();
    const name = `${'è'.repeat(900)}.txt`;
    const cipher = await seal(bytes(3), k, { name });
    expect(cipher.length).toBe(ciphertextLength(3));
    const { manifest } = await open(cipher, k);
    expect(manifest.name.endsWith('.txt')).toBe(true);
    expect(manifest.name.startsWith('èèè')).toBe(true);
    expect(new TextEncoder().encode(manifest.name).length).toBeLessThan(1024);
  });

  it('reports progress up to the whole file', async () => {
    const seen: number[] = [];
    await encryptFile(source(bytes(2 * CHUNK_BYTES + 1)), { name: 'a', type: '' }, ID, key(), {
      subtle,
      onProgress: (done) => seen.push(done)
    });
    expect(seen.at(-1)).toBe(2 * CHUNK_BYTES + 1);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
  });
});
