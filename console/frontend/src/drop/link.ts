/**
 * The NeroDrop share link: https://<console>/drop#r=<transfer id>.<key>
 *
 * Both parts sit in the fragment, which a browser never sends to a server, so neither
 * the console, its reverse proxy nor any access log ever sees the key. Whoever holds
 * the link can open the file until it expires; the console still hands the ciphertext
 * only to the recipient it was addressed to.
 */

export const DROP_PATH = '/drop';
const ID = /^[0-9a-f]{32}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function buildDropLink(origin: string, id: string, key: Uint8Array): string {
  return `${origin}${DROP_PATH}#r=${id}.${toBase64Url(key)}`;
}

/** Reads a whole link, its fragment, or the bare "<id>.<key>"; null for anything else. */
export function parseDropLink(text: string): { id: string; key: Uint8Array } | null {
  let value = text.trim();
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(hash + 1);
  if (value.startsWith('r=')) value = value.slice(2);
  const [id, key, ...rest] = value.split('.');
  if (rest.length > 0 || !id || !key || !ID.test(id) || !KEY.test(key)) return null;
  const raw = fromBase64Url(key);
  if (!raw || raw.length !== 32 || toBase64Url(raw) !== key) return null;
  return { id, key: raw };
}
