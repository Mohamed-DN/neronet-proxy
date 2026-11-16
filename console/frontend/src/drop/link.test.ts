import { describe, expect, it } from 'vitest';

import { buildDropLink, parseDropLink } from './link';

const ID = '0123456789abcdef0123456789abcdef';
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7);

describe('NeroDrop share link', () => {
  it('carries the id and the key in the fragment only', () => {
    const link = buildDropLink('https://console.example.com', ID, KEY);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://console.example.com/drop');
    expect(url.search).toBe('');
    expect(url.hash.startsWith(`#r=${ID}.`)).toBe(true);
  });

  it('reads back what it wrote, from a full link, a fragment or the bare value', () => {
    const link = buildDropLink('https://console.example.com', ID, KEY);
    const hash = new URL(link).hash;
    for (const text of [link, hash, hash.slice(3), `  ${link}\n`]) {
      const parsed = parseDropLink(text);
      expect(parsed?.id, text).toBe(ID);
      expect(parsed?.key, text).toEqual(KEY);
    }
  });

  it('rejects anything that is not a whole link', () => {
    const good = new URL(buildDropLink('https://console.example.com', ID, KEY)).hash.slice(3);
    for (const text of [
      '',
      'hello',
      `${ID}.`,
      `${ID.toUpperCase()}.${good.split('.')[1]}`,
      good.slice(0, -2),
      `${good}AA`
    ]) {
      expect(parseDropLink(text), text).toBeNull();
    }
  });
});
