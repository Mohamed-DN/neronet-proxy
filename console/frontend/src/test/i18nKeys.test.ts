import { describe, expect, it } from 'vitest';

import i18n from '../i18n';

/**
 * Every literal `t('key')` in a component must resolve in English, in the
 * namespaces the file declares or in `ui` (the fallback). A key that only
 * existed in a section this task deleted fails here.
 */

const TSX_FILES = import.meta.glob(['../**/*.tsx', '!../**/*.test.*', '!../design/**'], {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

interface Usage {
  file: string;
  namespaces: string[];
  key: string;
}

function collect(): Usage[] {
  const usages: Usage[] = [];
  for (const [path, source] of Object.entries(TSX_FILES)) {
    const file = path.replace(/^\.\.\//, '');
    const declared = [...source.matchAll(/useTranslation\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g)].flatMap((match) =>
      [...(match[1] ?? '').matchAll(/['"]([\w-]+)['"]/g)].map((name) => name[1] ?? '')
    );
    const namespaces = declared.length > 0 ? declared : ['ui'];
    // A call may name its namespace in options: t('key', { ns: 'glossary' }).
    for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"](?:\s*,\s*\{[^}]*?\bns:\s*['"]([\w-]+)['"])?/g)) {
      const callNs = match[2] ? [match[2]] : namespaces;
      usages.push({ file, namespaces: callNs, key: match[1] ?? '' });
    }
  }
  return usages;
}

describe('literal translation keys resolve in English', () => {
  it('every t() key exists in a declared namespace or in ui', () => {
    const missing: string[] = [];
    for (const { file, namespaces, key } of collect()) {
      const [explicit, bare] = key.includes(':')
        ? [key.split(':')[0], key.slice(key.indexOf(':') + 1)]
        : [undefined, key];
      const lookup = explicit ? [explicit, 'ui'] : [...namespaces, 'ui'];
      // count: 1 makes i18next check the plural forms (key_one, key_other) as well.
      if (!i18n.exists(bare, { lng: 'en', ns: lookup, count: 1 })) missing.push(`${file}: ${key}`);
    }
    expect(missing.join('\n')).toBe('');
  });
});
