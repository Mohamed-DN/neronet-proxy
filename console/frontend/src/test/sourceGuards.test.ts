import { describe, expect, it } from 'vitest';

/**
 * Cross-page guards. The source and the locale files are imported as text at
 * build time (import.meta.glob), so a regression in any page fails here even
 * when that page has no test of its own.
 */

const SOURCE_FILES = import.meta.glob(['../**/*.{ts,tsx,js,jsx}', '!../**/*.test.*', '!../design/**'], {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

const LOCALE_FILES = import.meta.glob('../i18n/locales/**/*.json', {
  import: 'default',
  eager: true
}) as Record<string, Record<string, unknown>>;

const SOURCES = Object.entries(SOURCE_FILES).map(([path, text]) => ({
  rel: path.replace(/^\.\.\//, ''),
  lines: text.split('\n')
}));

/** `file:line` for every line that matches. */
function hits(pattern: RegExp, only?: (rel: string) => boolean): string[] {
  const found: string[] = [];
  for (const { rel, lines } of SOURCES) {
    if (only && !only(rel)) continue;
    lines.forEach((line: string, index: number) => {
      if (pattern.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  return found;
}

/** One line per finding, so a failure prints every item in full. */
function none(found: string[]) {
  expect(found.join('\n')).toBe('');
}

function localeFile(locale: 'en' | 'it', ns: string): Record<string, unknown> {
  const doc = LOCALE_FILES[`../i18n/locales/${locale}/${ns}.json`];
  if (!doc) throw new Error(`missing locale file ${locale}/${ns}.json`);
  return doc;
}

function localeValues(locale: 'en' | 'it'): Array<{ file: string; value: string }> {
  const out: Array<{ file: string; value: string }> = [];
  const visit = (file: string, node: unknown) => {
    if (typeof node === 'string') out.push({ file, value: node });
    else if (node && typeof node === 'object') for (const child of Object.values(node)) visit(file, child);
  };
  for (const [path, doc] of Object.entries(LOCALE_FILES)) {
    if (path.includes(`/${locale}/`)) visit(path, doc);
  }
  return out;
}

function valueAt(source: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      source
    );
}

describe('source guards', () => {
  it('no native dialogs', () => {
    const native = /\bwindow\.(alert|confirm|prompt)\(|(^|[^.\w])(alert|confirm|prompt)\(/;
    none(hits(native));
  });

  it('no legacy .jsx pages in src/components', () => {
    none(SOURCES.filter(({ rel }) => rel.startsWith('components/') && rel.endsWith('.jsx')).map(({ rel }) => rel));
  });

  it('no uppercase class', () => {
    none(hits(/className.*\buppercase\b/));
  });

  it('no invented fallbacks', () => {
    const invented = [
      /\|\|\s*18\.2/,
      /\|\|\s*'US'/,
      /\|\|\s*'CLIENT_ORIGIN'/,
      /\|\|\s*'Regional'/,
      /risk_delta\s*\|\|/,
      /'100\.64\.0\.0\/16'/
    ];
    for (const pattern of invented) expect(hits(pattern).join('\n'), String(pattern)).toBe('');
  });

  it('no banned claims in locales', () => {
    const banned = /\b3D\b|immutab|plausib|negabilit|sovereign|sovran/i;
    for (const locale of ['en', 'it'] as const) {
      none(
        localeValues(locale)
          .filter(({ value }) => banned.test(value))
          .map(({ file, value }) => `${file}: ${value}`)
      );
    }
  });

  it('every page namespace has a one-sentence description of at most 25 words in en and it', () => {
    const pages: Array<[string, string]> = [
      ['overview', 'description'],
      ['topology', 'description'],
      ['subnets', 'description'],
      ['nodes', 'description'],
      ['onion', 'description'],
      ['peering', 'description'],
      ['cloudpc', 'description'],
      ['risk', 'description'],
      ['acl', 'description'],
      ['audit', 'description'],
      ['users', 'description'],
      ['settings', 'description'],
      ['nuke', 'description'],
      ['portal', 'me.description'],
      ['glossary', 'page.description']
    ];
    for (const locale of ['en', 'it'] as const) {
      for (const [ns, path] of pages) {
        const text = valueAt(localeFile(locale, ns), path);
        const where = `${locale}:${ns}.${path}`;
        expect(typeof text, where).toBe('string');
        const sentences = (text as string).split(/(?<=[.!?])\s+/).filter(Boolean);
        expect(sentences.length, where).toBe(1);
        expect((text as string).split(/\s+/).length, where).toBeLessThanOrEqual(25);
      }
    }
  });

  it('portal CTAs are at most 24 characters in en and it', () => {
    const ctas = ['me.add', 'add.submit', 'add.result.back', 'add.result.download', 'add.result.copy'];
    for (const locale of ['en', 'it'] as const) {
      const source = localeFile(locale, 'portal');
      for (const path of ctas) {
        const text = valueAt(source, path);
        expect(typeof text, `${locale}:portal.${path}`).toBe('string');
        expect((text as string).length, `${locale}:portal.${path}`).toBeLessThanOrEqual(24);
      }
    }
  });

  it('no JSX literal text in pages', () => {
    const literal = />\s*[A-Za-z][A-Za-z ,.'!?-]{2,}\s*</;
    const scoped = (rel: string) => /^(routes\/pages|portal|components|devices|command)\/[^/]+\.tsx$/.test(rel);
    const found = hits(literal, scoped).filter((where) => {
      const rel = where.slice(0, where.lastIndexOf(':'));
      const line = Number(where.slice(where.lastIndexOf(':') + 1));
      const source = SOURCES.find((s) => s.rel === rel);
      return !source?.lines[line - 1]?.includes('// i18n-exempt');
    });
    none(found);
  });
});
