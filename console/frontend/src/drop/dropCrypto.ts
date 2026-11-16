/**
 * NeroDrop end-to-end encryption (ADR 0033), done in the browser with WebCrypto.
 *
 * A fresh random 256-bit key per transfer. The file becomes:
 *
 *   sealed manifest (1024 bytes + 16-byte tag)   name, type, size, chunk size
 *   sealed chunk 0 (up to 1 MiB + 16)
 *   ...
 *   sealed chunk n-1 (the final one; an empty file has one empty final chunk)
 *
 * Each piece is AES-256-GCM with a 96-bit nonce made of four zero bytes and the
 * piece's index as a 64-bit big-endian number (manifest 0, chunk i is i + 1), and
 * associated data "nerodrop/v1/<transfer id>/<index>/<final 0|1>". Reordering,
 * truncation, a piece from another transfer and any changed byte all fail
 * authentication. The manifest has a fixed size, so the ciphertext length gives away
 * the file size (to within the tags) and nothing else; the name never leaves here
 * unencrypted.
 *
 * Nothing in this module writes to storage, the URL or the network.
 */

export const CHUNK_BYTES = 1024 * 1024;
export const MANIFEST_BYTES = 1024;
export const TAG_BYTES = 16;
const SEALED_MANIFEST = MANIFEST_BYTES + TAG_BYTES;

export interface Manifest {
  name: string;
  type: string;
}

export interface OpenedManifest extends Manifest {
  v: 1;
  size: number;
  chunk: number;
}

/** Something to read the plaintext from: a File in the browser, bytes in a test. */
export interface Source {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface CryptoOptions {
  subtle?: SubtleCrypto;
  onProgress?: (done: number, total: number) => void;
}

/** The ciphertext does not match the key, the transfer, or is incomplete. */
export class DropIntegrityError extends Error {
  constructor(message = 'The file could not be decrypted: wrong link, or the data was changed or cut short.') {
    super(message);
    this.name = 'DropIntegrityError';
  }
}

export class DropCryptoUnavailable extends Error {
  constructor() {
    super('This browser cannot encrypt: WebCrypto needs a secure (https) page.');
    this.name = 'DropCryptoUnavailable';
  }
}

function subtleOf(options?: { subtle?: SubtleCrypto }): SubtleCrypto {
  const subtle = options?.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new DropCryptoUnavailable();
  return subtle;
}

function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_BYTES));
}

/** How many bytes the ciphertext of a `size`-byte file has: what the console is told. */
export function ciphertextLength(size: number): number {
  return SEALED_MANIFEST + size + chunkCount(size) * TAG_BYTES;
}

/** 32 random bytes from the platform's secure generator. */
export function newFileKey(source: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto): Uint8Array {
  if (!source?.getRandomValues) throw new DropCryptoUnavailable();
  const key = new Uint8Array(32);
  source.getRandomValues(key);
  return key;
}

function nonce(index: number): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(index), false);
  return out;
}

function associated(id: string, index: number, final: boolean): Uint8Array {
  return new TextEncoder().encode(`nerodrop/v1/${id}/${index}/${final ? 1 : 0}`);
}

async function importKey(subtle: SubtleCrypto, raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (raw.length !== 32) throw new DropIntegrityError('A NeroDrop key is 32 bytes.');
  return subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [usage]);
}

async function sealPiece(
  subtle: SubtleCrypto,
  key: CryptoKey,
  id: string,
  index: number,
  final: boolean,
  plain: Uint8Array
): Promise<Uint8Array> {
  const sealed = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce(index) as BufferSource,
      additionalData: associated(id, index, final) as BufferSource,
      tagLength: 128
    },
    key,
    plain as BufferSource
  );
  return new Uint8Array(sealed);
}

async function openPiece(
  subtle: SubtleCrypto,
  key: CryptoKey,
  id: string,
  index: number,
  final: boolean,
  sealed: Uint8Array
): Promise<Uint8Array> {
  try {
    const plain = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce(index) as BufferSource,
        additionalData: associated(id, index, final) as BufferSource,
        tagLength: 128
      },
      key,
      sealed as BufferSource
    );
    return new Uint8Array(plain);
  } catch {
    throw new DropIntegrityError();
  }
}

/** Shortens a name, keeping its extension, until the manifest fits. */
function fitName(name: string, type: string, size: number): Uint8Array {
  const encoder = new TextEncoder();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  let stem = ext ? name.slice(0, dot) : name;
  let safeType = type.length <= 128 ? type : '';
  for (;;) {
    const json = encoder.encode(JSON.stringify({ v: 1, name: stem + ext, type: safeType, size, chunk: CHUNK_BYTES }));
    if (json.length <= MANIFEST_BYTES) {
      const padded = new Uint8Array(MANIFEST_BYTES).fill(0x20);
      padded.set(json);
      return padded;
    }
    if (stem.length === 0) safeType = '';
    stem = Array.from(stem)
      .slice(0, Math.max(0, Array.from(stem).length - 16))
      .join('');
  }
}

/** Encrypts `source`; the parts, in order, are the whole ciphertext. */
export async function encryptFile(
  source: Source,
  manifest: Manifest,
  id: string,
  rawKey: Uint8Array,
  options: CryptoOptions = {}
): Promise<Uint8Array[]> {
  const subtle = subtleOf(options);
  const key = await importKey(subtle, rawKey, 'encrypt');
  const size = source.size;
  const parts = [await sealPiece(subtle, key, id, 0, false, fitName(manifest.name, manifest.type, size))];
  const n = chunkCount(size);
  for (let i = 0; i < n; i++) {
    const start = i * CHUNK_BYTES;
    const end = Math.min(size, start + CHUNK_BYTES);
    const plain = end > start ? await source.read(start, end) : new Uint8Array(0);
    parts.push(await sealPiece(subtle, key, id, i + 1, i === n - 1, plain));
    options.onProgress?.(end, size);
  }
  return parts;
}

/**
 * Decrypts a ciphertext that arrives in pieces of any size. `push` each piece as it
 * comes; `finish` answers the manifest and the plaintext parts, or throws
 * DropIntegrityError when anything is wrong or missing. No plaintext is handed out
 * before the whole transfer has been authenticated.
 */
export class Decryptor {
  private readonly id: string;
  private readonly rawKey: Uint8Array;
  private readonly subtle: SubtleCrypto;
  private readonly onProgress: CryptoOptions['onProgress'];
  private key: CryptoKey | null = null;
  private pending: Uint8Array = new Uint8Array(0);
  private manifestValue: OpenedManifest | null = null;
  private next = 0; // the next data chunk to open
  private received = 0;
  private readonly parts: Uint8Array[] = [];

  constructor(id: string, rawKey: Uint8Array, options: CryptoOptions = {}) {
    this.id = id;
    this.rawKey = rawKey;
    this.subtle = subtleOf(options);
    this.onProgress = options.onProgress;
  }

  get manifest(): OpenedManifest | null {
    return this.manifestValue;
  }

  async push(piece: Uint8Array): Promise<void> {
    if (!this.key) this.key = await importKey(this.subtle, this.rawKey, 'decrypt');
    const merged = new Uint8Array(this.pending.length + piece.length);
    merged.set(this.pending);
    merged.set(piece, this.pending.length);
    this.pending = merged;
    this.received += piece.length;
    await this.drain();
    if (this.manifestValue) this.onProgress?.(this.received, ciphertextLength(this.manifestValue.size));
  }

  private sealedLength(i: number, m: OpenedManifest): number {
    const n = chunkCount(m.size);
    const plain = i < n - 1 ? m.chunk : m.size - (n - 1) * m.chunk;
    return plain + TAG_BYTES;
  }

  private async drain(): Promise<void> {
    const key = this.key as CryptoKey;
    if (!this.manifestValue) {
      if (this.pending.length < SEALED_MANIFEST) return;
      const plain = await openPiece(this.subtle, key, this.id, 0, false, this.pending.slice(0, SEALED_MANIFEST));
      this.pending = this.pending.slice(SEALED_MANIFEST);
      this.manifestValue = parseManifest(plain);
    }
    const m = this.manifestValue;
    const n = chunkCount(m.size);
    while (this.next < n) {
      const want = this.sealedLength(this.next, m);
      if (this.pending.length < want) return;
      const plain = await openPiece(
        this.subtle,
        key,
        this.id,
        this.next + 1,
        this.next === n - 1,
        this.pending.slice(0, want)
      );
      this.pending = this.pending.slice(want);
      this.parts.push(plain);
      this.next++;
    }
    if (this.pending.length > 0) throw new DropIntegrityError();
  }

  async finish(): Promise<{ manifest: OpenedManifest; parts: Uint8Array[] }> {
    const m = this.manifestValue;
    if (!m || this.next < chunkCount(m.size) || this.pending.length > 0) throw new DropIntegrityError();
    return { manifest: m, parts: this.parts };
  }
}

function parseManifest(plain: Uint8Array): OpenedManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new DropIntegrityError();
  }
  const m = doc as Partial<OpenedManifest>;
  if (
    !m ||
    m.v !== 1 ||
    typeof m.name !== 'string' ||
    typeof m.type !== 'string' ||
    !Number.isSafeInteger(m.size) ||
    (m.size as number) < 0 ||
    m.chunk !== CHUNK_BYTES
  ) {
    throw new DropIntegrityError('This file was made by a NeroDrop version this page does not read.');
  }
  return { v: 1, name: m.name, type: m.type, size: m.size as number, chunk: m.chunk };
}
