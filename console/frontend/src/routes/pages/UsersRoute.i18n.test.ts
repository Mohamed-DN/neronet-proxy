import { describe, expect, it } from 'vitest';

import enUsers from '../../i18n/locales/en/users.json';
import itUsers from '../../i18n/locales/it/users.json';
import source from './UsersRoute.tsx?raw';

// UsersRoute used to carry ~75 `t('key', 'English default')` calls: a key missing from a
// locale silently rendered English, and the dialogs held plain English literals. Every key
// must now exist in both locales, and no call may carry its own English fallback.

function has(tree: unknown, key: string): boolean {
  let node = tree as Record<string, unknown> | string | undefined;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false;
    node = node[part] as Record<string, unknown> | string;
  }
  return true;
}

const hasPlural = (tree: unknown, key: string) =>
  has(tree, key) || has(tree, `${key}_one`) || has(tree, `${key}_other`);

// A call of the page's own namespace: t('some.key' ...), not one that names another ns.
const CALL = /\bt\(\s*'([^']+)'\s*(,[^)]*)?/g;

describe('UsersRoute translations', () => {
  const calls = [...source.matchAll(CALL)]
    .map((m) => ({ key: m[1] ?? '', rest: m[2] ?? '' }))
    .filter((c) => !/ns:\s*'/.test(c.rest));

  it('finds the page translations', () => {
    expect(calls.length).toBeGreaterThan(60);
  });

  it('uses no inline English default', () => {
    const withDefault = calls.filter((c) => /^,\s*['"`]/.test(c.rest)).map((c) => c.key);
    expect(withDefault).toEqual([]);
  });

  it('has every key in both locales', () => {
    const missingEn = calls.filter((c) => !hasPlural(enUsers, c.key)).map((c) => c.key);
    const missingIt = calls.filter((c) => !hasPlural(itUsers, c.key)).map((c) => c.key);
    expect({ missingEn, missingIt }).toEqual({ missingEn: [], missingIt: [] });
  });

  it('has no English sentence left in the markup', () => {
    const literals = [
      ...source.matchAll(/(?:placeholder|aria-label|title|description)=(?:"([^"]+)"|\{`([^`]+)`\})/g)
    ].map((m) => m[1] ?? m[2]);
    expect(literals).toEqual([]);
    expect(source).not.toMatch(/\n\s+'[A-Z][a-z]+ [^']{20,}'\n/);
    expect(source).not.toMatch(/\n\s+No apps currently bypassed/);
  });
});
