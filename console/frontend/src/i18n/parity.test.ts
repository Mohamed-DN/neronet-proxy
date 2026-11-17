import { describe, expect, it } from 'vitest';

import i18n, { NAMESPACES } from './index';

const en = import.meta.glob('./locales/en/*.json', { eager: true, import: 'default' }) as Record<
  string,
  Record<string, unknown>
>;
const itLocale = import.meta.glob('./locales/it/*.json', { eager: true, import: 'default' }) as Record<
  string,
  Record<string, unknown>
>;

function flatten(value: unknown, prefix = '', out: string[] = []): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.push(prefix);
  }
  return out;
}

const fileName = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.json$/, '');

describe('locale files', () => {
  it('every namespace has the same flattened key set in en and it', () => {
    const enNames = Object.keys(en).map(fileName).sort();
    const itNames = Object.keys(itLocale).map(fileName).sort();
    expect(itNames).toEqual(enNames);

    for (const path of Object.keys(en)) {
      const itPath = path.replace('/locales/en/', '/locales/it/');
      const itFile = itLocale[itPath];
      expect(itFile, `missing it file for ${path}`).toBeDefined();
      expect(flatten(itFile).sort(), `keys differ in ${fileName(path)}`).toEqual(flatten(en[path]).sort());
    }
  });

  it('NAMESPACES lists every file in locales/en', () => {
    const enNames = Object.keys(en).map(fileName);
    expect(NAMESPACES).toEqual(expect.arrayContaining(enNames));
    expect(NAMESPACES).toEqual(expect.arrayContaining(['portal', 'glossary']));
  });

  it('a key missing from a page namespace falls back to ui', () => {
    expect(i18n.t('state.notMeasured', { ns: 'nodes' })).toBe('Not measured');
  });

  it('no string uses a single-brace placeholder that i18next would print as is', () => {
    const bad: string[] = [];
    const scan = (value: unknown, where: string) => {
      if (typeof value === 'string') {
        if (/(?<!\{)\{[A-Za-z_][\w.]*\}(?!\})/.test(value)) bad.push(`${where}: ${value}`);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) scan(child, `${where}.${key}`);
      }
    };
    for (const [path, file] of [...Object.entries(en), ...Object.entries(itLocale)])
      scan(file, fileName(path) + ` (${path.split('/')[2]})`);
    expect(bad).toEqual([]);
  });
});
